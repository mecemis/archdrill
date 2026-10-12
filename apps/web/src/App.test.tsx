import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App shell", () => {
  it("renders the product name and the design canvas", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "ArchDrill" })).toBeDefined();
    expect(screen.getByRole("main", { name: "Design canvas" })).toBeDefined();
  });
});
