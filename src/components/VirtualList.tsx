import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

interface VirtualListProps<T> {
  items: T[];
  className?: string;
  itemClassName?: string;
  role?: string;
  overscan?: number;
  virtualizationThreshold?: number;
  getKey: (item: T, index: number) => string;
  getItemSize?: (item: T, index: number) => number;
  renderItem: (item: T, index: number) => ReactNode;
}

function findStartIndex(offsets: number[], sizes: number[], scrollTop: number) {
  let low = 0;
  let high = offsets.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid] + sizes[mid] < scrollTop) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return low;
}

function findEndIndex(offsets: number[], viewportBottom: number) {
  let low = 0;
  let high = offsets.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid] <= viewportBottom) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return low;
}

export function VirtualList<T>({
  items,
  className,
  itemClassName,
  role,
  overscan = 6,
  virtualizationThreshold = 60,
  getKey,
  getItemSize = () => 44,
  renderItem,
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const metrics = useMemo(() => {
    const sizes = items.map((item, index) => getItemSize(item, index));
    const offsets = new Array<number>(items.length);
    let totalSize = 0;

    for (let index = 0; index < items.length; index += 1) {
      offsets[index] = totalSize;
      totalSize += sizes[index] ?? 0;
    }

    return {
      offsets,
      sizes,
      totalSize,
    };
  }, [getItemSize, items]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const measure = () => {
      setViewportHeight(node.clientHeight);
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver(() => {
      measure();
    });
    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, [items.length]);

  const shouldVirtualize = items.length >= virtualizationThreshold && viewportHeight > 0;

  return (
    <div
      ref={containerRef}
      className={className}
      role={role}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      {shouldVirtualize ? (
        <div className="virtual-list__inner" style={{ height: metrics.totalSize }}>
          {(() => {
            const viewportTop = Math.max(0, scrollTop);
            const viewportBottom = viewportTop + viewportHeight;
            const start = Math.max(0, findStartIndex(metrics.offsets, metrics.sizes, viewportTop) - overscan);
            const end = Math.min(
              items.length,
              findEndIndex(metrics.offsets, viewportBottom) + overscan,
            );

            return items.slice(start, end).map((item, visibleIndex) => {
              const index = start + visibleIndex;
              return (
                <div
                  key={getKey(item, index)}
                  className={itemClassName}
                  style={{
                    position: "absolute",
                    top: metrics.offsets[index],
                    left: 0,
                    right: 0,
                    height: metrics.sizes[index],
                  }}
                >
                  {renderItem(item, index)}
                </div>
              );
            });
          })()}
        </div>
      ) : (
        items.map((item, index) => (
          <div key={getKey(item, index)} className={itemClassName}>
            {renderItem(item, index)}
          </div>
        ))
      )}
    </div>
  );
}
