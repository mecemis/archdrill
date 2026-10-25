import { describe, expect, it } from "vitest";
import { operationsFocusFirst } from "./triggers";

describe("operationsFocusFirst", () => {
  it("lists the focus operations first, each group in the problem's order", () => {
    const ids = operationsFocusFirst(["record-click", "redirect"]).map((o) => o.id);

    expect(ids).toEqual([
      "redirect",
      "record-click",
      "create-link",
      "disable-link",
      "purge-expired",
      "scan-link",
    ]);
  });
});
