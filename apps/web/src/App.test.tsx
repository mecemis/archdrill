import { AttemptSchema } from "@archdrill/model";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { useAttemptStore } from "./state/store";

/** Visitors → ALB → Link API (3 replicas) → DynamoDB holding Link, with no flows yet. */
function topologyOnly() {
  return AttemptSchema.parse({
    schemaVersion: 1,
    problemId: "url-shortener",
    problemVersion: 1,
    architecture: {
      components: [
        { id: "visitors", kind: "client", flavor: "browser", label: "Visitors" },
        { id: "lb", kind: "load-balancer", flavor: "alb", label: "ALB", size: "managed" },
        {
          id: "api",
          kind: "service",
          flavor: "generic",
          label: "Link API",
          size: "m",
          replicas: 3,
        },
        {
          id: "links",
          kind: "key-value-db",
          flavor: "dynamodb",
          label: "Links",
          data: [{ entity: "Link" }],
        },
      ],
      connections: [
        { id: "visitors--lb", from: "visitors", to: "lb" },
        { id: "lb--api", from: "lb", to: "api" },
        { id: "api--links", from: "api", to: "links" },
      ],
    },
  });
}

function renderApp() {
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

function form() {
  return within(screen.getByTestId("add-step-form"));
}

function fillSlot(slotIndex: number, fill: () => void) {
  const slots = within(screen.getByTestId("step-tree")).getAllByRole("button", {
    name: "Add step",
  });
  const slot = slots[slotIndex];
  if (!slot) throw new Error(`no slot ${slotIndex}`);
  fireEvent.click(slot);
  fill();
  fireEvent.click(form().getByRole("button", { name: "Add step" }));
}

function respond(status: number) {
  return () => {
    fireEvent.click(form().getByRole("button", { name: "Respond" }));
    fireEvent.change(form().getByLabelText("Status"), { target: { value: String(status) } });
  };
}

describe("App", () => {
  beforeEach(() => {
    useAttemptStore.getState().replace(topologyOnly());
  });

  it("shows the problem and asks for the first flow", () => {
    renderApp();

    expect(screen.getByRole("heading", { name: /ArchDrill/ })).toBeDefined();
    expect(screen.getByText("Waiting for flows")).toBeDefined();
  });

  it("records a redirect flow in the step tree and evaluates it", () => {
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "Start the flow" }));
    fireEvent.click(screen.getByRole("button", { name: "Add the first step" }));
    fireEvent.click(form().getByRole("button", { name: "Add step" })); // Links · read Link
    fillSlot(0, () => fireEvent.click(form().getByRole("button", { name: "Logic" }))); // found → check expiry
    fillSlot(0, respond(302)); // valid
    fillSlot(0, respond(410)); // expired
    fillSlot(0, respond(404)); // notFound
    fillSlot(0, respond(503)); // error

    expect(screen.queryAllByRole("button", { name: "Add step" })).toEqual([]);
    expect(screen.getByTestId("scenario-score").textContent).toBe("100");
    expect(screen.getByRole("tab", { name: /Paths/ }).textContent).toContain("4");
  });

  it("gives gate feedback when the notFound outcome redirects", () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Start the flow" }));
    fireEvent.click(screen.getByRole("button", { name: "Add the first step" }));
    fireEvent.click(form().getByRole("button", { name: "Add step" }));
    fillSlot(0, () => fireEvent.click(form().getByRole("button", { name: "Logic" })));
    fillSlot(0, respond(302));
    fillSlot(0, respond(410));
    fillSlot(0, respond(302)); // notFound → 302: wrong
    fillSlot(0, respond(503));

    expect(screen.getByText("Not passing")).toBeDefined();
    expect(screen.getByText("Unknown codes answer 404")).toBeDefined();
  });
});
