// Browse UI state: current folder + list/grid view preference. Kept separate
// from `session` (which owns the manifest/connection) so browse state can be
// reset independently on profile switch without a circular import.
type View = "list" | "grid";
const VIEW_KEY = "bare-bucket/view";

function storedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export const browse = $state({
  prefix: "",
  view: storedView() as View,

  navigate(prefix: string) {
    browse.prefix = prefix;
  },
  toggleView() {
    browse.view = browse.view === "list" ? "grid" : "list";
    try {
      localStorage.setItem(VIEW_KEY, browse.view);
    } catch {
      /* view preference is best-effort */
    }
  },
  reset() {
    browse.prefix = "";
  },
});
