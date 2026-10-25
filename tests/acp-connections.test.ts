import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { ACP_AGENTS, parseAcpConfig } from "../src/core/acp.ts";
import { sanitizeUserSettings, type UserSettings } from "../src/core/settings.ts";
import { callCost, sessionCost } from "../src/core/prices.ts";
import { stores } from "../src/server/stores.ts";
import { connectAcp, disconnectAcp, engineForSpec } from "../src/server/acp.ts";
import { modelCatalog, validateModelsSettings } from "../src/server/model-catalog.ts";
import { POST, DELETE } from "../app/api/acp/[id]/route.ts";
import { configureAcpHost } from "./helpers/acp-host.ts";
import { normalizeContext } from "@earendil-works/pi-ai";
import { localAcpRequest } from "../src/server/acp-host.ts";

const fixture = path.join(import.meta.dirname, "fixtures", "acp-agent.mjs");
const config = (mode = "text") => ({ command: process.execPath, args: [fixture, mode] });

describe("ACP configuration and billing", () => {
	it("validates executable/argument boundaries and sanitizes corrupt saved connections", () => {
		assert.equal(parseAcpConfig({ command: "x\nother" }).ok, false);
		assert.equal(parseAcpConfig({ args: "--flag" }).ok, false);
		assert.equal(parseAcpConfig({ enabled: "yes" }).ok, false);
		assert.deepEqual(parseAcpConfig({ command: " node ", args: ["space in path.js"], token: "must not persist" }), { ok: true, config: { command: "node", args: ["space in path.js"] } });
		const clean = sanitizeUserSettings({ version: 1, acp: { codex: { enabled: true, command: "node", args: ["script.js"] }, claude: { enabled: "yes" } }, future: "preserved" });
		assert.deepEqual(clean?.acp, { codex: { enabled: true, command: "node", args: ["script.js"] } });
		assert.equal(clean?.future, "preserved");
		assert.deepEqual(sanitizeUserSettings({ acp: "broken" })?.acp, {});
	});
	it("subscription calls are excluded from API charges and can coexist with priced API turns", () => {
		assert.equal(callCost({}, "acp-codex:default"), 0);
		assert.equal(callCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, "acp-claude:default"), 0);
		assert.equal(callCost({}, "unknown:default"), null);
		const summary = sessionCost({ turns: [{ id: "sub", messageId: "m", at: "now", model: "acp-codex:default", steps: [{ inputTokens: undefined, outputTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined }] }] });
		assert.deepEqual(summary, { cost: 0, unpriced: 0 });
	});
});

describe("ACP connections and model composition", { concurrency: false }, () => {
	it("connects both agents without keys, validates every slot, and disconnects without changing pins", async (test) => {
		configureAcpHost(test, { codex: config(), claude: config() });
		let record: UserSettings = { version: 1, general: { autoUpdate: false } };
		test.mock.method(stores.settingsStore, "readSettings", () => record);
		test.mock.method(stores.settingsStore, "writeSettings", (next: unknown) => { record = sanitizeUserSettings(next)!; return record; });
		for (const agent of ACP_AGENTS) {
			const result = await connectAcp(agent.id, {});
			assert.equal(result.ok, true, JSON.stringify(result));
			assert.equal(record.acp?.[agent.id]?.enabled, true);
			const catalog = modelCatalog();
			const dto = catalog.models.find((model) => model.provider === agent.provider)!;
			assert.equal(dto.billing, "subscription");
			assert.ok(dto.input.includes("image"));
			assert.equal(catalog.providers.find((provider) => provider.id === agent.provider)?.keyPresent, false);
			assert.equal(catalog.providers.find((provider) => provider.id === agent.provider)?.connectionReady, true);
			const pin = { model: { provider: agent.provider, id: "default" } };
			record.models = { strong: pin, cheap: pin, vision: pin };
			assert.equal(validateModelsSettings(record.models).ok, true);
			assert.equal(engineForSpec(pin.model).model.api, "acp");
			disconnectAcp(agent.id);
			assert.throws(() => engineForSpec(pin.model), /disconnected/);
			assert.equal(modelCatalog().models.some((model) => model.provider === agent.provider), false);
			assert.equal(record.models.strong?.model?.provider, agent.provider);
		}
		assert.equal(record.general?.autoUpdate, false);
	});

	it("missing login, API login, and incompatible adapters never enable a connection", async (test) => {
		const host = configureAcpHost(test);
		const record: UserSettings = { version: 1 };
		test.mock.method(stores.settingsStore, "readSettings", () => record);
		const write = test.mock.method(stores.settingsStore, "writeSettings", () => { throw new Error("Failed connections must not persist"); });
		for (const mode of ["auth", "api-auth", "no-http", "no-image"]) {
			host("codex", config(mode));
			const result = await connectAcp("codex", {});
			assert.equal(result.ok, false, mode);
			if (!result.ok) assert.equal(result.status, 503);
		}
		assert.equal(write.mock.callCount(), 0);
	});
	it("HTTP-writable settings cannot replace the trusted host executable", async (test) => {
		configureAcpHost(test, { codex: config() });
		test.mock.method(stores.settingsStore, "readSettings", () => ({ version: 1, acp: { codex: { enabled: true, command: "must-never-launch", args: ["untrusted"] } } }));
		const engine = engineForSpec({ provider: "acp-codex", id: "default" });
		const response = await engine.streamFn(engine.model, normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] })).result();
		assert.equal(response.stopReason, "stop", response.errorMessage);
	});

	it("HTTP routes validate origin, payload and agent ID before spawning", async (test) => {
		configureAcpHost(test);
		const context = { params: Promise.resolve({ id: "codex" }) };
		const crossOrigin = new Request("http://localhost/api/acp/codex", { method: "POST", headers: { origin: "https://unrelated.example", "content-type": "application/json" }, body: "{}" });
		assert.equal((await POST(crossOrigin, context)).status, 403);
		assert.equal((await POST(new Request("http://localhost/api/acp/codex", { method: "POST", body: "{}" }), context)).status, 403);
		assert.equal((await POST(new Request("http://localhost/api/acp/unknown", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ id: "unknown" }) })).status, 404);
		assert.equal((await POST(new Request("http://localhost/api/acp/codex", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: '{"args":1}' }), context)).status, 400);
		assert.equal((await POST(new Request("http://localhost/api/acp/codex", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(config()) }), context)).status, 400, "browser input cannot choose an executable or its arguments");
		assert.equal((await DELETE(new Request("http://localhost/api/acp/codex", { method: "DELETE", headers: { origin: "https://unrelated.example" } }), context)).status, 403);
	});
	it("public web mode and missing Origin cannot change local process connections", async (test) => {
		configureAcpHost(test);
		test.mock.method(stores.settingsStore, "readSettings", () => ({ version: 1 }));
		test.mock.method(stores.settingsStore, "writeSettings", () => ({ version: 1 }));
		process.env.LH_LOCAL_APP = "0";
		const context = { params: Promise.resolve({ id: "codex" }) };
		const request = new Request("http://localhost/api/acp/codex", { method: "DELETE", headers: { origin: "http://localhost" } });
		assert.equal((await DELETE(request, context)).status, 403);
		process.env.LH_LOCAL_APP = "1";
		assert.equal((await DELETE(new Request(request.url, { method: "DELETE" }), context)).status, 403);
	});
	it("accepts Next's canonical URL with the browser's loopback Host/Origin, rejecting other origins and ports", (test) => {
		configureAcpHost(test);
		const canonical = "http://localhost:3005/api/acp/codex";
		const request = (host: string, origin: string) => new Request(canonical, { headers: { host, origin } });
		assert.equal(localAcpRequest(request("127.0.0.1:3005", "http://127.0.0.1:3005")), true);
		assert.equal(localAcpRequest(request("127.0.0.1:3005", "https://unrelated.example")), false);
		assert.equal(localAcpRequest(request("unrelated.example:3005", "http://unrelated.example:3005")), false);
		assert.equal(localAcpRequest(request("127.0.0.1:3006", "http://127.0.0.1:3006")), false);
	});
});
