import {
  AttemptSchema,
  applyCommand,
  type CommandArgs,
  type CommandName,
  exportAttempt,
} from "@archdrill/model";
import {
  asyncAttempt,
  cacheAsideAttempt,
  createLinkAttempt,
  disableLinkAttempt,
} from "@archdrill/model/testing";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { useAttemptStore } from "./state/store";
import { useUi } from "./state/ui-store";

// Panels, tabs and the drawer live in a global store; every test starts from its defaults.
beforeEach(() => {
  useUi.setState(useUi.getInitialState());
});

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

/** Chooses a step in the open step picker by what it does. */
function choose(label: string | RegExp) {
  const picker = within(screen.getByTestId("step-picker"));
  const [option] = picker.getAllByRole("button", { name: label });
  if (!option) throw new Error(`no step "${String(label)}"`);
  fireEvent.click(option);
}

/** Changes where an outcome of a step goes: "If not found: 404" → 302. */
function endOutcomeWith(outcome: string, status: number) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^If ${outcome}:`) }));
  const menu = within(screen.getByRole("dialog", { name: `What happens if ${outcome}` }));
  fireEvent.click(menu.getByRole("button", { name: String(status) }));
}

/** Opens a step's settings from its options menu. */
function openSettings(stepId: string) {
  const card = within(screen.getByTestId(`step-${stepId}`));
  fireEvent.click(card.getByRole("button", { name: "Step options" }));
  fireEvent.click(screen.getByRole("button", { name: /^Settings/ }));
}

/** The read path of S2: read the link, check its expiry, redirect. */
function buildReadPath() {
  fireEvent.click(screen.getByRole("button", { name: "Start the flow" }));
  choose("Read Link from Links"); // not found → 404 and error → 503 by default
  choose("Check expiry"); // expired → 410 by default
  choose("Respond 302 Found");
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

  it("builds a redirect flow as a list of steps and evaluates it", () => {
    renderApp();

    buildReadPath();

    expect(screen.queryByTestId("step-picker")).toBeNull();
    expect(screen.getByText("Every branch ends with a response.")).toBeDefined();
    expect(screen.getByRole("button", { name: "If not found: 404" })).toBeDefined();
    expect(screen.getByTestId("scenario-score").textContent).toBe("100");
    expect(screen.getByRole("tab", { name: /Paths/ }).textContent).toContain("4");
  });

  it("gives gate feedback when the notFound outcome redirects", () => {
    renderApp();
    buildReadPath();

    endOutcomeWith("not found", 302); // wrong: unknown codes must not redirect

    expect(screen.getByText("Not passing")).toBeDefined();
    expect(screen.getByText("Unknown codes answer 404")).toBeDefined();
  });

  it("lets an outcome run steps of its own", () => {
    renderApp();
    buildReadPath();

    fireEvent.click(screen.getByRole("button", { name: /^If error:/ }));
    fireEvent.click(screen.getByRole("button", { name: /Do something else first/ }));
    choose("Read Link from Links"); // try the read once more

    expect(screen.getByRole("button", { name: "If error: steps below" })).toBeDefined();
    expect(screen.getByText("If error:")).toBeDefined();
  });

  it("inserts a step in front of another and carries on into it", () => {
    renderApp();
    buildReadPath();
    const read = within(screen.getByTestId("step-read-link"));

    fireEvent.click(read.getByRole("button", { name: "Step options" }));
    fireEvent.click(screen.getByRole("button", { name: /Insert a step before/ }));
    choose("Check status");

    const flow = useAttemptStore.getState().attempt.flows.find((f) => f.operation === "redirect");
    expect(flow?.root).toBe("check-status");
    expect(flow?.steps["check-status"]).toMatchObject({ next: { active: "read-link" } });
  });

  it("adds a usual pattern as its steps, in one change", () => {
    useAttemptStore.getState().replace(cacheAsideAttempt());
    useAttemptStore.getState().dispatch("removeFlow", { operation: "redirect" });
    useAttemptStore.getState().dispatch("createFlow", { operation: "redirect", handler: "api" });
    renderApp();

    // An empty flow opens the picker at its first step.
    const picker = within(screen.getByTestId("step-picker"));
    fireEvent.click(picker.getByRole("button", { name: /^Cache-aside: Look up Link in Redis/ }));

    const flow = () =>
      useAttemptStore.getState().attempt.flows.find((f) => f.operation === "redirect");
    expect(flow()?.root).toBe("get-link");
    expect(flow()?.steps["get-link"]).toMatchObject({ next: { miss: "read-link" } });
    expect(flow()?.steps["read-link"]).toMatchObject({ next: { found: "set-link" } });
    expect(screen.getByText("Every branch ends with a response.")).toBeDefined();

    act(() => useAttemptStore.getState().undo());
    expect(flow()?.root).toBeNull();
  });

  it("types a flow on the command line, one step after another", () => {
    renderApp();
    // Without a flow there is nowhere to add yet, and "/" says so.
    fireEvent.keyDown(window, { key: "/" });
    expect(
      screen.getByText("Choose the service that handles Redirect in the Flow panel first."),
    ).toBeDefined();
    act(() =>
      useAttemptStore.getState().dispatch("createFlow", { operation: "redirect", handler: "api" }),
    );

    fireEvent.keyDown(window, { key: "/" });
    const line = screen.getByRole("combobox", { name: "Type a step" }) as HTMLInputElement;
    expect(document.activeElement).toBe(line);

    // Escape clears what was typed first.
    fireEvent.change(line, { target: { value: "nothing like this" } });
    fireEvent.keyDown(line, { key: "Escape" });
    expect(line.value).toBe("");

    fireEvent.change(line, { target: { value: "read links" } });
    fireEvent.keyDown(line, { key: "Enter" });
    expect(line.value).toBe("");
    expect(screen.getByTestId("cursor-bar").textContent).toContain("Links · read Link, if found");

    fireEvent.change(line, { target: { value: "302" } });
    fireEvent.keyDown(line, { key: "Enter" });
    const flow = useAttemptStore.getState().attempt.flows.find((f) => f.operation === "redirect");
    expect(flow?.steps["read-link"]).toMatchObject({ next: { found: "r302" } });
    expect(screen.getByText("Every branch ends with a response.")).toBeDefined();
    // Every branch leads somewhere now: typing carries on in front of the response.
    expect(screen.getByTestId("cursor-bar").textContent).toContain("before responding");

    // Escape on an empty line stops adding, and "/" starts again.
    fireEvent.keyDown(line, { key: "Escape" });
    expect(screen.queryByTestId("cursor-bar")).toBeNull();
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Type a step" }));
  });

  it("shows a flow that only responds, and puts a step in front of the response", () => {
    useAttemptStore.getState().dispatch("createFlow", { operation: "redirect", handler: "api" });
    useAttemptStore.getState().dispatch("addStep", {
      operation: "redirect",
      id: "r404",
      step: { type: "respond", status: 404 },
      attach: { to: "root" },
    });
    renderApp();

    fireEvent.click(screen.getByRole("button", { name: "Add a step before responding" }));
    choose("Read Link from Links");

    const flow = useAttemptStore.getState().attempt.flows.find((f) => f.operation === "redirect");
    expect(flow?.root).toBe("read-link");
    expect(flow?.steps["read-link"]).toMatchObject({ next: { found: "r404" } });
  });

  it("opens one picker at a time, with a fresh search for each place", () => {
    renderApp();
    buildReadPath();
    const read = within(screen.getByTestId("step-check-expiry"));

    fireEvent.click(read.getByRole("button", { name: "Step options" }));
    fireEvent.click(screen.getByRole("button", { name: /Insert a step before/ }));
    expect(screen.getAllByTestId("step-picker")).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Search steps"), { target: { value: "status" } });
    choose("Check status");
    fireEvent.click(screen.getByRole("button", { name: /Respond 302 Found/ }));
    fireEvent.click(screen.getByRole("button", { name: /Do something else first/ }));

    expect(screen.getAllByTestId("step-picker")).toHaveLength(1);
    expect((screen.getByLabelText("Search steps") as HTMLInputElement).value).toBe("");
  });

  it("removes a step and joins what came before to what followed", () => {
    useAttemptStore.getState().replace(cacheAsideAttempt());
    renderApp();
    const first = within(screen.getByTestId("step-get"));

    fireEvent.click(first.getByRole("button", { name: "Step options" }));
    fireEvent.click(screen.getByRole("button", { name: /Remove step/ }));

    const flow = useAttemptStore.getState().attempt.flows[0];
    expect(flow?.root).toBe("read");
    expect(flow?.steps.get).toBeUndefined();
    expect(flow?.steps.expiryHit).toBeUndefined();
  });

  it("says where a component's numbers come from", () => {
    renderApp();
    act(() => useUi.getState().select({ type: "component", id: "links" }));

    fireEvent.click(screen.getByText("Where these numbers come from"));

    expect(screen.getByText("Amazon DynamoDB (on-demand, Standard table class)")).toBeDefined();
    const pricing = screen
      .getAllByRole("link")
      .find((a) => a.getAttribute("href") === "https://aws.amazon.com/dynamodb/pricing/on-demand/");
    expect(pricing).toBeDefined();
    expect(screen.getAllByText("published").length).toBeGreaterThan(0);
    // Prices read as the source states them, not rounded away.
    expect(screen.getByText("$0.125 per million reads, $0.625 per million writes")).toBeDefined();

    act(() => useUi.getState().select({ type: "component", id: "api" }));
    fireEvent.click(screen.getByText("Where these numbers come from"));

    expect(screen.getByText("c6i.2xlarge (EC2, 8 vCPU)")).toBeDefined();
    // A thin handler's throughput is the catalog's own assumption, and says so.
    expect(screen.getAllByText("assumption").length).toBeGreaterThan(0);
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
    choose("Get a new id from KGS");
    const id = useAttemptStore.getState().attempt.flows.find((f) => f.operation === "create-link")
      ?.root as string;
    openSettings(id);
    fireEvent.change(screen.getByLabelText(/Batch size/), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const flow = useAttemptStore
      .getState()
      .attempt.flows.find((f) => f.operation === "create-link");
    const root = flow ? flow.steps[flow.root ?? ""] : undefined;
    expect(root).toMatchObject({ type: "call", action: "ids.allocate", batchSize: 1000 });
    expect(root && "entity" in root ? root.entity : undefined).toBeUndefined();
    const card = within(screen.getByTestId(`step-${id}`));
    expect(card.getByText("Get a new id from KGS")).toBeDefined();
    expect(card.getByText("batch 1,000")).toBeDefined();
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
    // One scenario is named in full; several are listed (S8 counts redirects too).
    expect(
      screen.getByText(
        /^S2 Redirect \(read path\) dropped from \d+ to \d+|lowered \d+ scenarios: S2 /,
      ),
    ).toBeDefined();
    fireEvent.click(tab);
    expect(within(tab).queryByText(/^↓\d+/)).toBeNull();
  });

  it("does not warn about undo and redo", () => {
    useAttemptStore.getState().replace(redirectDesign());
    useUi.getState().setScenario("s1-create");
    renderApp();
    const tab = () => screen.getByRole("button", { name: /S2 Redirect/ });

    act(() => {
      useAttemptStore.getState().dispatch("updateComponent", { id: "api", replicas: 1 });
    });
    act(() => useAttemptStore.getState().undo());
    expect(within(tab()).queryByText(/^↓\d+/)).toBeNull();
    act(() => useAttemptStore.getState().redo());

    expect(within(tab()).queryByText(/^↓\d+/)).toBeNull();
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

    // Undo works with the checkbox still focused.
    const toggle = screen.getByRole("checkbox", { name: "Autoscale with load" });
    toggle.focus();
    fireEvent.keyDown(toggle, { key: "z", metaKey: true });
    fireEvent.keyDown(toggle, { key: "z", metaKey: true });
    expect(api()?.autoscale).toBeUndefined();
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

describe("App with background work", () => {
  /** The async test design, with the queue size the real catalog offers. */
  function backgroundDesign() {
    return applyCommand(asyncAttempt(), "updateComponent", { id: "queue", size: "on-demand" })
      .attempt;
  }

  const chooseOperation = (id: string) => {
    fireEvent.click(screen.getByRole("tab", { name: "Flow" }));
    fireEvent.change(screen.getByLabelText("Operation"), { target: { value: id } });
  };

  beforeEach(() => {
    useAttemptStore.getState().replace(backgroundDesign());
    useUi.getState().setScenario("s7-edge-cases");
  });

  it("shows a consumer as optional, where its messages come from, and what its statuses mean", () => {
    renderApp();
    chooseOperation("scan-link");

    expect(
      screen.getByRole("option", { name: "on Link created · Scan new link (in focus)" }),
    ).toBeDefined();
    expect(screen.getByText(/^Optional: a consumer of Link created/)).toBeDefined();
    expect(screen.getByText("Takes Link created messages from Link events.")).toBeDefined();
    expect(screen.getAllByText(/200 done/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/503 try again later/).length).toBeGreaterThan(0);
  });

  it("asks a consumer's service to connect to the queue when it receives nothing", () => {
    useAttemptStore.getState().dispatch("removeConnection", { id: "worker--queue" });
    renderApp();
    chooseOperation("scan-link");

    expect(screen.getByText(/Worker receives no Link created messages/)).toBeDefined();
  });

  it("publishes an event chosen from the problem's events", () => {
    useAttemptStore.getState().dispatch("removeFlow", { operation: "disable-link" });
    useAttemptStore
      .getState()
      .dispatch("createFlow", { operation: "disable-link", handler: "api" });
    renderApp();
    chooseOperation("disable-link");

    choose("Publish Link created to Link events");

    const root = useAttemptStore
      .getState()
      .attempt.flows.find((f) => f.operation === "disable-link")?.root as string;
    expect(
      within(screen.getByTestId(`step-${root}`)).getByText("Publish Link created to Link events"),
    ).toBeDefined();
  });

  it("offers batches that collect items to jobs", () => {
    useAttemptStore.getState().dispatch("removeFlow", { operation: "purge-expired" });
    useAttemptStore.getState().dispatch("createFlow", {
      operation: "purge-expired",
      handler: "worker",
    });
    renderApp();
    chooseOperation("purge-expired");
    choose(/^Delete Link from /);
    openSettings("delete-link");

    expect(screen.getByLabelText(/items wait for the batch to fill/)).toBeDefined();
  });

  it("does not offer batches that collect items to requests", () => {
    useAttemptStore.getState().dispatch("removeFlow", { operation: "disable-link" });
    useAttemptStore
      .getState()
      .dispatch("createFlow", { operation: "disable-link", handler: "api" });
    renderApp();
    chooseOperation("disable-link");
    choose(/^Delete Link from /);
    openSettings("delete-link");

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
    expect(screen.queryByLabelText(/Batch size/)).toBeNull();
  });
});

describe("estimation gym", () => {
  beforeEach(() => {
    useAttemptStore.getState().replace(cacheAsideAttempt());
  });

  it("checks a whiteboard number against its tolerance band, and undo takes it back", () => {
    renderApp();
    fireEvent.click(screen.getByRole("tab", { name: "Estimate" }));
    const question = screen.getByLabelText("How many links are created on an average day?");
    const card = question.closest("li") as HTMLElement;

    fireEvent.change(question, { target: { value: "1B" } });
    fireEvent.click(within(card).getByRole("button", { name: "Check" }));
    expect(within(card).getByText("Off: 12× too high")).toBeDefined();

    fireEvent.change(question, { target: { value: "90M" } });
    fireEvent.click(within(card).getByRole("button", { name: "Check" }));
    expect(within(card).getByText("Spot on")).toBeDefined();
    expect(screen.getByTestId("estimate-summary").textContent).toMatch(
      /^1 of \d+ answered · 1 spot on/,
    );
    expect(useAttemptStore.getState().attempt.estimates["links-per-day"]).toBe(90e6);

    act(() => useAttemptStore.getState().undo());
    expect(useAttemptStore.getState().attempt.estimates["links-per-day"]).toBe(1e9);
  });

  it("keeps the derived numbers in the brief until the candidate asks for them", () => {
    renderApp();

    expect(screen.queryByText(/158 B links over 5 years/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "show them now" }));
    expect(screen.getByText(/158 B links over 5 years/)).toBeDefined();
  });
});
