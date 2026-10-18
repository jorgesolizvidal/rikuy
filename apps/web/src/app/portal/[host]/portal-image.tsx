import type { ResponsiveImage } from "@/server/portal-content";

/**
 * A published photo: pre-sized WebP derivatives in `srcset` (480/960/1600, never enlarged),
 * explicit width/height so the page does not jump while it loads, lazy by default.
 * The derivatives are already optimized and immutable, so next/image would only add a
 * second resize; a plain <img> is the lighter choice here.
 */
export function PortalImage({
  image,
  sizes,
  priority = false,
  className,
}: {
  readonly image: ResponsiveImage;
  readonly sizes: string;
  readonly priority?: boolean;
  readonly className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={image.src}
      srcSet={image.srcSet}
      sizes={sizes}
      width={image.width}
      height={image.height}
      alt={image.alt}
      decoding="async"
      loading={priority ? "eager" : "lazy"}
      {...(priority ? { fetchPriority: "high" as const } : {})}
    />
  );
}
