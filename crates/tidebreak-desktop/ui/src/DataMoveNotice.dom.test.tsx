// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DataMoveNotice, dataMoveCopy } from "./DataMoveNotice";

const MOVED = {
  dataDir:
    "/Users/alex/Library/Application Support/io.github.naingthet.tidebreak",
  credentialsKept: false,
  macos: true,
};

afterEach(cleanup);

describe("DataMoveNotice", () => {
  it("says where the conversations are now and what macOS asks again", () => {
    const { container } = render(
      <DataMoveNotice move={MOVED} onDismiss={vi.fn()} />,
    );
    expect(screen.getByText("Tidebreak moved your data")).toBeTruthy();
    // The path keeps the space inside a folder name from breaking the line.
    expect(
      container.querySelector("p")?.textContent?.replaceAll("\u00a0", " "),
    ).toBe(
      "Your conversations and settings are now in ~/Library/Application Support/io.github.naingthet.tidebreak.",
    );
    expect(screen.getByTitle(MOVED.dataDir)).toBeTruthy();
    expect(
      screen.getByText(
        "macOS may ask again for Accessibility and Screen Recording, and for access to your keychain.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/sign in again/)).toBeNull();
  });

  it("asks to sign in again only when the saved keys stayed behind", () => {
    const { container } = render(
      <DataMoveNotice
        move={{ ...MOVED, credentialsKept: true }}
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        "Your saved keys did not come across, so sign in again in Settings to the providers and engines you use.",
      ),
    ).toBeTruthy();
    expect(
      container
        .querySelector('[data-slot="notice"]')
        ?.getAttribute("data-tone"),
    ).toBe("warning");
  });

  it("leaves the macOS prompts out elsewhere", () => {
    const copy = dataMoveCopy({
      dataDir: "/home/alex/.local/share/io.github.naingthet.tidebreak",
      credentialsKept: false,
      macos: false,
    });
    expect(copy.path).toBe("~/.local/share/io.github.naingthet.tidebreak");
    expect(copy.next).toEqual([]);
  });

  it("dismisses", () => {
    const onDismiss = vi.fn();
    render(<DataMoveNotice move={MOVED} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
