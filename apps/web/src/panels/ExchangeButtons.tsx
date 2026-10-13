import { exportAttempt, importAttempt } from "@archdrill/model";
import { Download, Upload } from "lucide-react";
import { useRef } from "react";
import { activePack } from "../state/content";
import { useAttemptStore } from "../state/store";
import { useToasts } from "../state/toasts";
import { useUi } from "../state/ui-store";
import { Button } from "../ui/primitives";

/** Saves the design to a file, or loads one, upgrading designs saved by earlier versions. */
export function ExchangeButtons() {
  const input = useRef<HTMLInputElement>(null);
  const notify = useToasts((s) => s.notify);

  const download = () => {
    const text = exportAttempt(useAttemptStore.getState().attempt);
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `archdrill-${activePack.problem.id}-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const upload = async (file: File) => {
    try {
      const attempt = importAttempt(await file.text());
      if (attempt.problemId !== activePack.problem.id) {
        notify(`That design is for another problem (${attempt.problemId}).`, "error");
        return;
      }
      if (attempt.problemVersion !== activePack.problem.version) {
        notify(
          `That design was made for version ${attempt.problemVersion} of the problem; scenarios may have changed since.`,
        );
      }
      useAttemptStore.getState().replace(attempt, { undoable: true });
      useUi.getState().select(null);
      useUi.getState().armSlot(null);
      notify(`Loaded ${file.name}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "The file could not be read.", "error");
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        onClick={download}
        title="Export: save the design to a file"
        aria-label="Export design"
      >
        <Download className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        onClick={() => input.current?.click()}
        title="Import: load a design from a file"
        aria-label="Import design"
      >
        <Upload className="h-4 w-4" />
      </Button>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-label="Design file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void upload(file);
        }}
      />
    </>
  );
}
