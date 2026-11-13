import type { Brand } from '@/lib/brand';

/** The app name, with the agency's logo when it has one. */
export function BrandMark({ brand, as = 'span' }: { brand: Brand; as?: 'span' | 'p' }) {
  const Tag = as;
  return (
    <Tag className="brand">
      {brand.logo_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={brand.logo_url} alt="" className="brand-logo" width={24} height={24} referrerPolicy="no-referrer" />
      ) : null}
      {brand.app_name}
    </Tag>
  );
}
