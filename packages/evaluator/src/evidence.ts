/** What a finding points at, so the UI can highlight it on the canvas and in the path explorer. */
export type Evidence =
  | { readonly type: "component"; readonly componentId: string }
  | { readonly type: "connection"; readonly connectionId: string }
  | {
      readonly type: "step";
      readonly operation: string;
      readonly stepId: string;
      readonly outcome?: string;
    }
  | { readonly type: "path"; readonly operation: string; readonly pathId: string }
  /** A decision under Decisions, for findings about trade-offs a diagram cannot show. */
  | { readonly type: "decision"; readonly decision: string };
