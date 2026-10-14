import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { useOnboarding } from "../state/onboarding";

// jsdom lacks the layout APIs React Flow relies on; provide inert stand-ins.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= ResizeObserverStub;

// Tests run as a returning visitor: the first-visit welcome screen and the guide stay closed.
beforeEach(() => {
  useOnboarding.setState({ welcomed: true, guideOpen: false, spotlight: null });
});

afterEach(() => {
  cleanup();
});
