import { render } from "@solidjs/testing-library";
import { describe, it, expect } from "vitest";
import { Icon } from "../../src/chat-solid/components/Icon";

describe("Icon", () => {
  it("renders an svg with use href", () => {
    const { container } = render(() => <Icon name="plus" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    const use = svg?.querySelector("use");
    expect(use?.getAttribute("href") ?? use?.getAttributeNS?.("http://www.w3.org/1999/xlink", "href")).toBe("#peyt-chat-icon-plus");
  });

  it("applies size", () => {
    const { container } = render(() => <Icon name="plus" size="large" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("20");
  });

  it("falls back to plus when unknown icon", () => {
    const { container } = render(() => <Icon name="this-does-not-exist" />);
    const use = container.querySelector("use");
    expect(use?.getAttribute("href") ?? use?.getAttributeNS?.("http://www.w3.org/1999/xlink", "href")).toBe("#peyt-chat-icon-plus");
  });
});
