/**
 * The ordinary page's content. It was inline in the showcase file, which no longer exists — the
 * route declares placement and this holds the data, which is the split the design asks for.
 */
export interface Item {
  /** The sku the cart intent takes. It is the same table `lib/data.ts` validates against. */
  sku: string
  name: string
  price: number
  unit: string
  badge: string
  available: boolean
}

export const CATEGORIES: Record<string, { intro: string; items: Item[] }> = {
  pantry: {
    intro:
      'Three cards, one sealed component template, and a page that arrives in one piece. No slot on this route asks to stream, so the plan lowers to in-order and nothing pays for a fill mechanism.',
    items: [
      {
        sku: 'RICE-5K',
        name: 'Amber rice, 5 kg',
        price: 12_000,
        unit: 'IQD',
        badge: 'Basra mill',
        available: true,
      },
      {
        sku: 'DATE-1K',
        name: 'Barhi dates, 1 kg',
        price: 3_500,
        unit: 'IQD',
        badge: 'in season',
        available: true,
      },
      {
        sku: 'TEA-500',
        name: 'Ceylon tea, 500 g',
        price: 4_100,
        unit: 'IQD',
        badge: 'back in stock soon',
        available: false,
      },
    ],
  },
  household: {
    intro:
      'The same component, different props. Changing the category changes the content and not the template — which is why page weight tracks content here rather than the number of components on the page.',
    items: [
      {
        sku: 'OIL-2L',
        name: 'Sunflower oil, 2 L',
        price: 6_250,
        unit: 'IQD',
        badge: 'bulk',
        available: true,
      },
      {
        sku: 'SUGAR-2K',
        name: 'Cane sugar, 2 kg',
        price: 2_900,
        unit: 'IQD',
        badge: 'household',
        available: true,
      },
      {
        sku: 'SOAP-6',
        name: 'Olive soap, 6 bars',
        price: 5_400,
        unit: 'IQD',
        badge: 'Nablus',
        available: true,
      },
    ],
  },
}
