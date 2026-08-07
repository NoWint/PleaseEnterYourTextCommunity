import { render } from "@solidjs/testing-library";
import { describe, it, expect } from "vitest";
import { Avatar } from "../../src/chat-solid/components/Avatar";

describe("Avatar", () => {
  it("shows fallback initials when no src", () => {
    const { getByText } = render(() => <Avatar name="张三" />);
    expect(getByText("张")).toBeTruthy();
  });

  it("renders img when src provided", () => {
    const { container } = render(() => <Avatar name="x" src="blob:abc" />);
    expect(container.querySelector("img")).toBeTruthy();
  });

  it("applies size style to fallback", () => {
    const { container } = render(() => <Avatar name="x" size="small" />);
    const span = container.querySelector(".peyt-avatar-fallback") as HTMLElement | null;
    expect(span).toBeTruthy();
    expect(span?.style.width).toBe("20px");
  });
});
