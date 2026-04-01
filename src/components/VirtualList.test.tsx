import { act } from "react";
import ReactDOM from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualList } from "./VirtualList";

type ActEnvironmentGlobal = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function renderVirtualList({
  virtualizationThreshold,
  scrollToIndex,
  scrollRequestKey,
}: {
  virtualizationThreshold: number;
  scrollToIndex: number;
  scrollRequestKey: number;
}) {
  const items = ["Artist A", "Artist B", "Artist C", "Artist D", "Artist E"];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);

  act(() => {
    root.render(
      <VirtualList
        items={items}
        className="test-list"
        itemClassName="test-list__item"
        virtualizationThreshold={virtualizationThreshold}
        scrollToIndex={scrollToIndex}
        scrollRequestKey={scrollRequestKey}
        scrollAlignment="start"
        getKey={(item) => item}
        getItemSize={() => 40}
        renderItem={(item) => <div>{item}</div>}
      />,
    );
  });

  return {
    container,
    root,
  };
}

describe("VirtualList", () => {
  let originalClientHeightDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    (globalThis as ActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
    originalClientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        const element = this as HTMLElement;
        return element.classList.contains("test-list") ? 60 : 0;
      },
    });
  });

  afterEach(() => {
    if (originalClientHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeightDescriptor);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    }
    document.body.innerHTML = "";
  });

  it("scrolls to the requested item offset when virtualization is disabled", async () => {
    const { container, root } = renderVirtualList({
      virtualizationThreshold: 999,
      scrollToIndex: 2,
      scrollRequestKey: 1,
    });

    const list = container.querySelector<HTMLDivElement>(".test-list");
    expect(list?.scrollTop).toBe(80);

    await act(async () => {
      root.unmount();
    });
  });

  it("scrolls to the requested item offset when virtualization is enabled", async () => {
    const { container, root } = renderVirtualList({
      virtualizationThreshold: 1,
      scrollToIndex: 2,
      scrollRequestKey: 1,
    });

    const list = container.querySelector<HTMLDivElement>(".test-list");
    expect(list?.scrollTop).toBe(80);

    await act(async () => {
      root.unmount();
    });
  });
});
