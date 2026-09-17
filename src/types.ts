export interface ProductDoc {
  brand_name: string;
  handle: string;
  title: string;
  category?: string;
  description?: string;
  tags?: string[];
  price?: number;
  currency?: string;
  available?: boolean;
  product_url?: string;
  primary_image?: string;
  website?: string;
  scraped_at?: string;
  [key: string]: unknown;
}

export interface BrandSummary {
  brand_name: string;
  website?: string;
  products: number;
  available: number;
  categories: number;
}

export interface Paging {
  page: number;
  limit: number;
  offset: number;
  total: number;
}
