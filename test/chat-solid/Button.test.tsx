import { render, fireEvent } from "@solidjs/testing-library";
import { describe, it, expect, vi } from "vitest";
import { Button } from "../../src/chat-solid/components/Button";

describe("Button", () => {
  it("renders children and handles click", async () => {
    const onClick = vi.fn();
    const { getByText } = render(() => <Button onClick={onClick}>发送</Button>);
    await fireEvent.click(getByText("发送"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("applies size data attribute", () => {
    const { getByRole } = render(() => <Button size="small">x</Button>);
    expect(getByRole("button").getAttribute("data-size")).toBe("small");
  });

  it("defaults variant to primary and size to normal", () => {
    const { getByRole } = render(() => <Button>ok</Button>);
    const btn = getByRole("button");
    expect(btn.getAttribute("data-variant")).toBe("primary");
    expect(btn.getAttribute("data-size")).toBe("normal");
  });
});
