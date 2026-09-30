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
  /** 'live' | 'dead' | 'unknown', written by scraping/check_product_links.py */
  product_link_status?: string;
  product_link_checked_at?: string;
  product_link_http_status?: number;
  primary_image?: string;
  website?: string;
  scraped_at?: string;
  [key: string]: unknown;
}

export interface BrandSummary {
  brand_name: string;
  website?: string;
  image?: string;
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


export interface MirrorSummary {
  mode: 'off' | 'mirror';
  reachable: boolean;
  docs?: number;
  reason?: string;
}
