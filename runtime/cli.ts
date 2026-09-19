import { serveStdio } from "./index.js";
import { serveBridgeFromArgv } from "./bridge-http.js";
import { serveMcpRelay } from "./mcp-relay.js";

if (process.argv.includes("--bridge")) {
	void serveBridgeFromArgv(process.argv);
} else if (process.argv.includes("--mcp-relay")) {
	void serveMcpRelay();
} else {
	void serveStdio();
}
