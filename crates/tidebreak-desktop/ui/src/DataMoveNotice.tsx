import { Fragment } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

import { displayDataDir } from "./BootFailure";
import type { DataMove } from "./desktopLifecycle";

type DataMoveNoticeProps = {
  move: DataMove;
  onDismiss: () => void;
};

/** What the notice says after Tidebreak moved its data to its new folder. */
export function dataMoveCopy(move: DataMove): {
  title: string;
  /** Where the data is now, as a person reads a path: home as `~`. */
  path: string;
  /** What to do or expect next, one sentence each. */
  next: string[];
} {
  const next: string[] = [];
  if (move.credentialsKept) {
    next.push(
      "Your saved keys did not come across, so sign in again in Settings to the providers and engines you use.",
    );
  }
  if (move.macos) {
    next.push(
      "macOS may ask again for Accessibility and Screen Recording, and for access to your keychain.",
    );
  }
  return {
    title: "Tidebreak moved your data",
    path: displayDataDir(move.dataDir),
    next,
  };
}

/**
 * A path that breaks only after a folder separator, never at a space inside a
 * folder name, so `Application Support` stays on one line in a narrow notice.
 * The home folder stays with the folder after it, so no line ends on `~/`.
 */
function PathText({ path, title }: { path: string; title: string }) {
  const [first = "", second = "", ...rest] = path.split(/(?<=[/\\])/);
  const parts = [first + second, ...rest].filter(Boolean);
  return (
    <span className="font-mono" title={title}>
      {parts.map((part, index) => (
        // The parts of one path never reorder, so their places are stable.
        <Fragment key={index}>
          {part.replaceAll(" ", " ")}
          {index < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </span>
  );
}

/**
 * The one-time notice after Tidebreak moved its data from the folder earlier
 * versions used (decision 103). It floats with the other launch notices, so
 * it takes the popover surface they stand on.
 */
export function DataMoveNotice({ move, onDismiss }: DataMoveNoticeProps) {
  const copy = dataMoveCopy(move);
  return (
    <Notice
      tone={move.credentialsKept ? "warning" : "info"}
      title={copy.title}
      className="bg-popover shadow-lg"
      action={
        <Button type="button" size="sm" variant="outline" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      <p>
        Your conversations and settings are now in{" "}
        <PathText path={copy.path} title={move.dataDir} />.
      </p>
      {copy.next.map((line) => (
        <p key={line} className="mt-1">
          {line}
        </p>
      ))}
    </Notice>
  );
}
