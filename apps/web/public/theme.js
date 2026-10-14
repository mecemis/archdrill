// Sets the theme before first paint, so a dark page never flashes light.
// state/theme.ts keeps it in sync afterwards; both read the same key.
(() => {
  let choice = "system";
  try {
    choice = localStorage.getItem("archdrill.theme") || "system";
  } catch {
    // Storage can be blocked; follow the system then.
  }
  const dark =
    choice === "dark" ||
    (choice !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
