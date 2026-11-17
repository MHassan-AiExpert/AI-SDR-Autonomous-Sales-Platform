import type { Brand } from '@/lib/brand';

/** The app name, with the agency's logo, or a monogram when there is no logo. */
export function BrandMark({ brand, as = 'span' }: { brand: Brand; as?: 'span' | 'p' }) {
  const Tag = as;
  return (
    <Tag className="brand">
      {brand.logo_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={brand.logo_url} alt="" className="brand-logo" width={34} height={34} referrerPolicy="no-referrer" />
      ) : (
        <span className="brand-mark" aria-hidden="true">{brand.app_name.trim().charAt(0).toUpperCase() || 'A'}</span>
      )}
      {brand.app_name}
    </Tag>
  );
}
