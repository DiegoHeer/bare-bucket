// Minimal session state — expanded by the connect flow.
import type { Manifest, WasmClient } from "./core";

interface Session {
  status: "connect" | "connected";
  profileName: string;
  client: WasmClient | null;
  manifest: Manifest | null;
  disconnect(): void;
}

export const session: Session = $state({
  status: "connect",
  profileName: "",
  client: null,
  manifest: null,
  disconnect() {
    session.status = "connect";
    session.client = null;
    session.manifest = null;
    session.profileName = "";
  },
});
