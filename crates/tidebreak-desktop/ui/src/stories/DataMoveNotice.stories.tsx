import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";

import { DataMoveNotice } from "@/DataMoveNotice";
import type { DataMove } from "@/desktopLifecycle";
import { FloatingNotices } from "@/FloatingNotices";
import { UncleanExitNotice } from "@/UncleanExitNotice";

const MACOS: DataMove = {
  dataDir:
    "/Users/alex/Library/Application Support/io.github.naingthet.tidebreak",
  credentialsKept: false,
  macos: true,
};

function DataMoveNoticeStory({
  move,
  withUncleanExit,
}: {
  move: DataMove;
  withUncleanExit: boolean;
}) {
  const [visible, setVisible] = useState(true);
  return (
    <div className="h-screen bg-page-background p-8">
      <div className="mx-auto max-w-2xl rounded-xl border border-border-subtle bg-background p-8">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Conversation
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Plan the next release
        </h1>
        <p className="mt-2 max-w-lg text-sm text-muted-foreground">
          The notice waits in the corner, over the work underneath it, until the
          person dismisses it. It shows once.
        </p>
      </div>
      <FloatingNotices>
        {visible && (
          <DataMoveNotice move={move} onDismiss={() => setVisible(false)} />
        )}
        {withUncleanExit && (
          <UncleanExitNotice
            save={{ status: "idle" }}
            onSave={fn()}
            onDismiss={fn()}
          />
        )}
      </FloatingNotices>
    </div>
  );
}

const meta = {
  title: "Shell/Data move notice",
  component: DataMoveNoticeStory,
  parameters: { layout: "fullscreen" },
  args: { move: MACOS, withUncleanExit: false },
} satisfies Meta<typeof DataMoveNoticeStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** macOS, after a move that brought the saved keys across. */
export const Moved: Story = {};

/** The person declined the keychain prompt: the keys stayed behind. */
export const KeysStayedBehind: Story = {
  args: { move: { ...MACOS, credentialsKept: true } },
};

/** Windows and Linux ask for nothing again. */
export const OtherPlatforms: Story = {
  args: {
    move: {
      dataDir:
        "C:\\Users\\alex\\AppData\\Roaming\\io.github.naingthet.tidebreak",
      credentialsKept: false,
      macos: false,
    },
  },
};

/** A long home folder wraps instead of pushing the notice wider. */
export const LongPath: Story = {
  args: {
    move: {
      ...MACOS,
      dataDir:
        "/Volumes/External Archive/alexandra.montgomery-whitfield/Library/Application Support/io.github.naingthet.tidebreak",
      credentialsKept: true,
    },
  },
};

/** Stacked with another launch notice. */
export const WithAnotherNotice: Story = {
  args: { withUncleanExit: true },
};
