import {
  AttemptSchema,
  applyCommand,
  type CommandArgs,
  type CommandName,
  exportAttempt,
} from "@archdrill/model";
import { cacheAsideAttempt, createLinkAttempt, disableLinkAttempt } from "@archdrill/model/testing";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { useAttemptStore } from "./state/store";
import { useUi } from "./state/ui-store";

/** Visitors → ALB → Link API (25 × 8 vCPU) → DynamoDB holding Link, with no flows yet. */
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
          size: "l",
          replicas: 25,
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

/** The topology with a complete redirect flow, which scores 100 in S2. */
function redirectDesign() {
  let attempt = topologyOnly();
  const run = <N extends CommandName>(name: N, args: CommandArgs<N>) => {
    attempt = applyCommand(attempt, name, args).attempt;
  };
  const at = (stepId: string, outcome: string) => ({ to: "outcome" as const, stepId, outcome });
  run("createFlow", { operation: "redirect", handler: "api" });
  run("addStep", {
    operation: "redirect",
    id: "read",
    step: { type: "call", target: "links", action: "store.read", entity: "Link" },
    attach: { to: "root" },
  });
  run("addStep", {
    operation: "redirect",
    id: "expiry",
    step: { type: "logic", logic: "checkExpiry" },
    attach: at("read", "found"),
  });
  run("addStep", {
    operation: "redirect",
    id: "r302",
    step: { type: "respond", status: 302 },
    attach: at("expiry", "valid"),
  });
  run("addStep", {
    operation: "redirect",
    id: "r410",
    step: { type: "respond", status: 410 },
    attach: at("expiry", "expired"),
  });
  run("addStep", {
    operation: "redirect",
    id: "r404",
    step: { type: "respond", status: 404 },
    attach: at("read", "notFound"),
  });
  run("addStep", {
    operation: "redirect",
    id: "r503",
    step: { type: "respond", status: 503 },
    attach: at("read", "error"),
  });
  return attempt;
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
    // These tests exercise the redirect read path (S2).
    useUi.getState().setScenario("s2-redirect");
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

  it("asks which branch to keep when removing a step with several continuations", () => {
    useAttemptStore.getState().replace(cacheAsideAttempt());
    renderApp();
    const tree = within(screen.getByTestId("step-tree"));

    fireEvent.click(tree.getAllByRole("button", { name: "Remove step" })[0] as HTMLElement);
    fireEvent.click(tree.getByRole("button", { name: /on miss: Postgres · read Link/ }));

    const flow = useAttemptStore.getState().attempt.flows[0];
    expect(flow?.root).toBe("read");
    expect(flow?.steps.get).toBeUndefined();
    expect(flow?.steps.expiryHit).toBeUndefined();
  });

  it("shows simulated load per environment", () => {
    useAttemptStore.getState().replace(cacheAsideAttempt());
    renderApp();

    fireEvent.click(screen.getByRole("tab", { name: "Load" }));

    expect(screen.getByRole("tab", { name: "Average" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Peak (×3)" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText("Cost at this load")).toBeDefined();
    expect(screen.getByRole("cell", { name: "Redis · Link" })).toBeDefined();
  });

  it("adds a batched allocation call without an entity", () => {
    let attempt = applyCommand(cacheAsideAttempt(), "addComponent", {
      id: "kgs",
      kind: "id-generator",
      flavor: "kgs",
      label: "KGS",
      position: { x: 0, y: 0 },
    }).attempt;
    attempt = applyCommand(attempt, "addConnection", { from: "api", to: "kgs" }).attempt;
    useAttemptStore.getState().replace(attempt);
    useUi.getState().setScenario("s1-create");
    renderApp();

    fireEvent.click(screen.getByRole("tab", { name: "Flow" }));
    fireEvent.click(screen.getByRole("button", { name: "Start the flow" }));
    fireEvent.click(screen.getByRole("button", { name: "Add the first step" }));
    fireEvent.change(form().getByLabelText("Component"), { target: { value: "kgs" } });
    expect(form().queryByLabelText("Entity")).toBeNull();
    fireEvent.change(form().getByLabelText(/Batch size/), { target: { value: "1000" } });
    fireEvent.click(form().getByRole("button", { name: "Add step" }));

    const flow = useAttemptStore
      .getState()
      .attempt.flows.find((f) => f.operation === "create-link");
    const root = flow ? flow.steps[flow.root ?? ""] : undefined;
    expect(root).toMatchObject({ type: "call", action: "ids.allocate", batchSize: 1000 });
    expect(root && "entity" in root ? root.entity : undefined).toBeUndefined();
    expect(screen.getByText("KGS · allocate id (batch 1,000)")).toBeDefined();
  });

  it("shows the ingress route while the flow has errors", () => {
    const raw = JSON.parse(JSON.stringify(createLinkAttempt("kgs")));
    const create = raw.flows.find((f: { operation: string }) => f.operation === "create-link");
    create.steps.insert.action = "store.insert"; // keeps a conflict link put does not have
    useAttemptStore.getState().replace(AttemptSchema.parse(raw));
    useUi.getState().setScenario("s1-create");
    renderApp();

    expect(screen.getByText(/^Not evaluable yet/)).toBeDefined();
    expect(screen.getByText(/^Ingress:/)).toBeDefined();
    expect(screen.queryByText(/No client can reach/)).toBeNull();
  });

  it("edits the call policy of a connection a service calls over", () => {
    useAttemptStore.getState().replace(cacheAsideAttempt());
    useUi.getState().select({ type: "connection", id: "api--redis" });
    renderApp();
    const policy = () =>
      useAttemptStore.getState().attempt.architecture.connections.find((c) => c.id === "api--redis")
        ?.policy;

    fireEvent.click(screen.getByRole("checkbox", { name: "Timeout" }));
    expect(policy()?.timeoutMs).toBe(50);
    const timeout = screen.getByRole("spinbutton", { name: "Timeout (ms)" });
    fireEvent.change(timeout, { target: { value: "20" } });
    fireEvent.keyDown(timeout, { key: "Enter" });
    fireEvent.click(screen.getByRole("checkbox", { name: /Circuit breaker/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Retries after a failed attempt" }), {
      target: { value: "2" },
    });

    expect(policy()).toMatchObject({ timeoutMs: 20, circuitBreaker: true, retries: 2 });
    expect(screen.getByRole("checkbox", { name: "Jitter" })).toBeDefined();

    // Values beyond the limit are clamped, and the field shows what was stored.
    fireEvent.change(timeout, { target: { value: "99999" } });
    fireEvent.blur(timeout);
    fireEvent.change(timeout, { target: { value: "99999" } });
    fireEvent.blur(timeout);
    expect(policy()?.timeoutMs).toBe(60_000);
    expect((timeout as HTMLInputElement).value).toBe("60000");
  });

  it("shows which components an environment breaks and what calls go through", () => {
    useAttemptStore.getState().replace(disableLinkAttempt("delete-after-update"));
    useUi.getState().setScenario("s4-cache-outage");
    renderApp();

    fireEvent.click(screen.getByRole("tab", { name: "Load" }));
    fireEvent.click(screen.getByRole("tab", { name: "Peak, cache cluster hanging" }));

    expect(
      screen.getByText("Every cache node stops answering; connections open but hang."),
    ).toBeDefined();
    expect(screen.getByText("Redis: hanging")).toBeDefined();
    expect(screen.getByRole("cell", { name: "Link API → Redis" })).toBeDefined();
  });

  it("warns when a change lowers another scenario's score", () => {
    useAttemptStore.getState().replace(redirectDesign());
    useUi.getState().setScenario("s1-create");
    renderApp();

    act(() => {
      useAttemptStore.getState().dispatch("updateComponent", { id: "api", replicas: 1 });
    });

    const tab = screen.getByRole("button", { name: /S2 Redirect/ });
    expect(within(tab).getByText(/^↓\d+/)).toBeDefined();
    expect(screen.getByText(/^S2 Redirect \(read path\) dropped from \d+ to \d+/)).toBeDefined();
    fireEvent.click(tab);
    expect(within(tab).queryByText(/^↓\d+/)).toBeNull();
  });

  it("imports an exported design and refuses one for another problem", async () => {
    renderApp();
    const file = (text: string) => new File([text], "design.json", { type: "application/json" });
    const input = screen.getByLabelText("Design file");

    fireEvent.change(input, { target: { files: [file(exportAttempt(cacheAsideAttempt()))] } });
    await screen.findByText("Loaded design.json.");
    expect(useAttemptStore.getState().attempt.architecture.components).toHaveLength(5);

    const other = { ...cacheAsideAttempt(), problemId: "chat" };
    fireEvent.change(input, { target: { files: [file(JSON.stringify(other))] } });
    expect(await screen.findByText("That design is for another problem (chat).")).toBeDefined();
  });

  it("compares the design with a pinned baseline", () => {
    useAttemptStore.getState().replace(redirectDesign());
    useUi.getState().setScenario("s2-redirect");
    renderApp();

    fireEvent.click(screen.getByRole("tab", { name: "Compare" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin as baseline" }));
    act(() => {
      useAttemptStore.getState().dispatch("updateComponent", { id: "api", replicas: 1 });
    });

    expect(screen.getByText("Link API: replicas 25 → 1")).toBeDefined();
    const row = screen.getByRole("row", { name: /S2 Redirect/ });
    expect(within(row).getByText(/^-\d+$/)).toBeDefined();
  });

  it("lets a service autoscale between its replicas and a maximum", () => {
    useAttemptStore.getState().replace(cacheAsideAttempt());
    useUi.getState().select({ type: "component", id: "api" });
    renderApp();
    const api = () =>
      useAttemptStore.getState().attempt.architecture.components.find((c) => c.id === "api");

    fireEvent.click(screen.getByRole("checkbox", { name: "Autoscale with load" }));
    expect(api()?.autoscale).toEqual({ max: 12, targetUtilization: 0.7 });
    const max = screen.getByRole("spinbutton", { name: "Maximum instances" });
    fireEvent.change(max, { target: { value: "40" } });
    fireEvent.blur(max);

    expect(api()?.autoscale?.max).toBe(40);
    expect(screen.getByText("Replicas (minimum) (3)")).toBeDefined();
  });

  it("records interview decisions and shows the approach the flow implements", () => {
    useAttemptStore.getState().replace(createLinkAttempt("kgs", 1000));
    useUi.getState().setScenario("s1-create");
    renderApp();

    fireEvent.click(screen.getByRole("tab", { name: "Decisions" }));
    const length = within(
      screen.getByRole("group", { name: "How many characters do generated codes have?" }),
    );
    expect(length.getByText(/^Assumed: 7 characters/)).toBeDefined();
    expect(length.getByText("affects the simulation")).toBeDefined();
    fireEvent.click(length.getByRole("radio", { name: /7 characters/ }));
    expect(useAttemptStore.getState().attempt.decisions["code-length"]).toBe("7");
    expect(length.queryByText(/^Assumed:/)).toBeNull();
    fireEvent.click(length.getByRole("radio", { name: /8 characters/ }));

    expect(useAttemptStore.getState().attempt.decisions["code-length"]).toBe("8");
    expect(screen.getAllByText("Key generation service").length).toBeGreaterThanOrEqual(2);
  });
});
