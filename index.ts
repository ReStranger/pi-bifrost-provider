import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBifrostProviders } from "./src/register-internal.ts";

export default function bifrostProvider(pi: ExtensionAPI) {
	registerBifrostProviders(pi);
}
