import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Prose } from "./Prose";

describe("Prose", () => {
  it("renders paragraphs and bulleted lists", () => {
    render(<Prose text={"First line\ncontinues here.\n\n- one\n- two"} />);

    expect(screen.getByText("First line continues here.")).toBeDefined();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["one", "two"]);
  });
});
