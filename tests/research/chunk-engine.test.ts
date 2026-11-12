import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  buildChunks,
  MAX_CHARS,
  splitOversizedText,
  type Block,
  type BlockCategory,
  type RetrievalRole,
} from "../../evals/chunk-engine.js";

const sourceUrl = "https://example.test/";

test("Distinct pricing offers stay separate", () => {
  const blocks: Block[] = [
    {
      id: 0,
      category: "company_claim",
      retrievalRole: "primary",
      relatedBlockIds: [],
      text: "Our fictional service packages",
    },
    {
      id: 1,
      category: "pricing",
      retrievalRole: "primary",
      relatedBlockIds: [2, 3],
      text: "Harbor Launch",
    },
    {
      id: 2,
      category: "pricing",
      retrievalRole: "primary",
      relatedBlockIds: [1],
      text: "### $2,400",
    },
    {
      id: 3,
      category: "pricing",
      retrievalRole: "primary",
      relatedBlockIds: [1],
      text: "One-time setup",
    },
    {
      id: 4,
      category: "pricing",
      retrievalRole: "primary",
      relatedBlockIds: [5, 6],
      text: "Harbor Care",
    },
    {
      id: 5,
      category: "pricing",
      retrievalRole: "primary",
      relatedBlockIds: [4],
      text: "### $300/month",
    },
    {
      id: 6,
      category: "pricing",
      retrievalRole: "primary",
      relatedBlockIds: [4],
      text: "Monthly maintenance",
    },
  ];

  const chunks = buildChunks({ sourceUrl, blocks });

  const launch = chunks.find((chunk) => chunk.text.includes("Harbor Launch"));

  const care = chunks.find((chunk) => chunk.text.includes("Harbor Care"));

  assert.ok(launch);
  assert.ok(care);

  assert.notEqual(launch.id, care.id);
  assert.match(launch.searchText, /\$2,400/);
  assert.match(care.searchText, /\$300\/month/);
});

test("Menu options stay together and context-only markup stays out of search text", () => {
  const blocks: Block[] = [
    {
      id: 0,
      category: "pricing",
      retrievalRole: "primary",
      relatedBlockIds: [1, 3],
      text: "Oven potatoes",
    },
    {
      id: 1,
      category: "pricing",
      retrievalRole: "primary",
      relatedBlockIds: [0],
      text: "$6",
    },
    {
      id: 2,
      category: "other",
      retrievalRole: "context",
      relatedBlockIds: [0, 3],
      text: "![Leaf badge](https://example.test/badge.svg)",
    },
    {
      id: 3,
      category: "company_claim",
      retrievalRole: "primary",
      relatedBlockIds: [0, 2],
      text: "Plant-based",
    },
    {
      id: 4,
      category: "pricing",
      retrievalRole: "primary",
      relatedBlockIds: [0],
      text: "Add herbs$7",
    },
    {
      id: 5,
      category: "interface_noise",
      retrievalRole: "excluded",
      relatedBlockIds: [],
      text: "* * *",
    },
    {
      id: 6,
      category: "pricing",
      retrievalRole: "primary",
      relatedBlockIds: [7],
      text: "Garden salad",
    },
    {
      id: 7,
      category: "pricing",
      retrievalRole: "primary",
      relatedBlockIds: [6],
      text: "$8",
    },
  ];

  const chunks = buildChunks({ sourceUrl, blocks });

  const potatoes = chunks.find((chunk) => chunk.blockIds.includes(0));

  const salad = chunks.find((chunk) => chunk.blockIds.includes(6));

  assert.ok(potatoes);
  assert.ok(salad);

  assert.deepEqual(potatoes.blockIds, [0, 1, 2, 3, 4]);
  assert.notEqual(potatoes.id, salad.id);

  // Original evidence remains available.
  assert.match(potatoes.text, /Leaf badge/);

  // The image is a context-role block inside a primary chunk, so the
  // role filter (not the Trustindex cleanup) keeps it out of search text.
  assert.doesNotMatch(potatoes.searchText, /Leaf badge/);

  // Meaningful attributes and prices survive.
  assert.match(potatoes.searchText, /Plant-based/);
  assert.match(potatoes.searchText, /Add herbs\$7/);
});

function sampleBlock(
  id: number,
  text: string,
  category: BlockCategory,
  retrievalRole: RetrievalRole,
  relatedBlockIds: number[] = [],
): Block {
  return { id, text, category, retrievalRole, relatedBlockIds };
}

test("Menu sections remain attached to individual items", () => {
  const blocks: Block[] = [
    sampleBlock(0, "* * *", "interface_noise", "excluded"),
    sampleBlock(1, "baked goods", "pricing", "primary"),
    sampleBlock(2, "* * *", "interface_noise", "excluded"),
    sampleBlock(3, "oat loaf", "pricing", "primary", [4]),
    sampleBlock(4, "$5", "pricing", "primary", [3]),
    sampleBlock(5, "* * *", "interface_noise", "excluded"),
    sampleBlock(6, "berry tart", "pricing", "primary", [7]),
    sampleBlock(7, "$7", "pricing", "primary", [6]),
  ];

  const chunks = buildChunks({ sourceUrl, blocks });

  const loaf = chunks.find((c) => c.blockIds.includes(3));
  const tart = chunks.find((c) => c.blockIds.includes(6));

  assert.ok(loaf);
  assert.ok(tart);

  assert.deepEqual(loaf.blockIds, [3, 4]);
  assert.deepEqual(tart.blockIds, [6, 7]);

  assert.equal(loaf.sectionTitle, "baked goods");
  assert.equal(tart.sectionTitle, "baked goods");
  assert.notEqual(loaf.id, tart.id);

  // The label is metadata, not a standalone embedding chunk, and the
  // source block stays traceable.
  assert.equal(chunks.length, 2);
  assert.equal(loaf.sectionBlockId, 1);
  assert.equal(tart.sectionBlockId, 1);
  assert.ok(chunks.every((c) => !c.blockIds.includes(1)));
  assert.equal(
    chunks.some((c) => c.text.trim() === "baked goods"),
    false,
  );

  // Retrieval sees the label, the original text does not change.
  assert.match(loaf.searchText, /^baked goods\n\noat loaf\n\n\$5$/);
  assert.equal(loaf.text, "oat loaf\n\n$5");
});

test("Distinct counseling services preserve their descriptions", () => {
  const blocks: Block[] = [
    sampleBlock(
      0,
      "## Family Planning Support",
      "company_claim",
      "primary",
      [1, 2],
    ),
    sampleBlock(
      1,
      "### Support for uncertain moments",
      "company_claim",
      "primary",
      [0],
    ),
    sampleBlock(
      2,
      "Help navigating stress during family planning.",
      "company_claim",
      "primary",
      [0],
    ),
    sampleBlock(
      3,
      "## Bereavement Support",
      "company_claim",
      "primary",
      [4, 5],
    ),
    sampleBlock(
      4,
      "### Space to process loss",
      "company_claim",
      "primary",
      [3],
    ),
    sampleBlock(
      5,
      "Support for people experiencing grief.",
      "company_claim",
      "primary",
      [3],
    ),
  ];

  const chunks = buildChunks({ sourceUrl, blocks });

  const planning = chunks.find((c) => c.blockIds.includes(0));
  const grief = chunks.find((c) => c.blockIds.includes(3));

  assert.ok(planning);
  assert.ok(grief);

  assert.deepEqual(planning.blockIds, [0, 1, 2]);
  assert.deepEqual(grief.blockIds, [3, 4, 5]);
  assert.notEqual(planning.id, grief.id);
});

test("Separate customer reviews retain their attribution", () => {
  const blocks: Block[] = [
    sampleBlock(0, "Posted on Google", "customer_review", "context", [1, 2, 3]),
    sampleBlock(1, "Alex Moreno", "customer_review", "context", [0]),
    sampleBlock(2, "11 October 2026", "customer_review", "context", [0]),
    sampleBlock(
      3,
      "Service was timely and helpful.",
      "customer_review",
      "context",
      [0],
    ),
    sampleBlock(4, "Posted on Google", "customer_review", "context", [5, 6, 7]),
    sampleBlock(5, "Morgan Lee", "customer_review", "context", [4]),
    sampleBlock(6, "12 October 2026", "customer_review", "context", [4]),
    sampleBlock(
      7,
      "Communication was clear.",
      "customer_review",
      "context",
      [4],
    ),
  ];

  const chunks = buildChunks({ sourceUrl, blocks });

  const first = chunks.find((c) => c.blockIds.includes(0));
  const second = chunks.find((c) => c.blockIds.includes(4));

  assert.ok(first);
  assert.ok(second);

  assert.deepEqual(first.blockIds, [0, 1, 2, 3]);
  assert.deepEqual(second.blockIds, [4, 5, 6, 7]);

  assert.notEqual(first.id, second.id);
  assert.match(first.searchText, /Alex Moreno/);
  assert.doesNotMatch(first.searchText, /Morgan Lee/);
});

const blockIdsOf = (chunks: Array<{ blockIds: number[] }>) =>
  chunks.map((chunk) => chunk.blockIds);

// Thematic breaks

test("Thematic breaks split chunks even when the classifier kept them", () => {
  const withoutBreak = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "First paragraph.", "company_claim", "primary"),
      sampleBlock(1, "Second paragraph.", "company_claim", "primary"),
    ],
  });

  // Control: nothing but the break separates these blocks.
  assert.deepEqual(blockIdsOf(withoutBreak), [[0, 1]]);

  for (const marker of ["* * *", "***", "---", "- - -", "___"]) {
    const chunks = buildChunks({
      sourceUrl,
      blocks: [
        sampleBlock(0, "First paragraph.", "company_claim", "primary"),
        // The classifier kept the break as primary content.
        sampleBlock(1, marker, "other", "primary"),
        sampleBlock(2, "Second paragraph.", "company_claim", "primary"),
      ],
    });

    assert.deepEqual(blockIdsOf(chunks), [[0], [2]], `marker ${marker}`);
    assert.ok(chunks.every((chunk) => !chunk.text.includes(marker)));
  }
});

test("Text that only resembles a break does not split", () => {
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "First paragraph.", "company_claim", "primary"),
      sampleBlock(1, "--", "company_claim", "primary"),
      sampleBlock(2, "**Note**", "company_claim", "primary"),
      sampleBlock(3, "- list item", "company_claim", "primary"),
    ],
  });

  assert.deepEqual(blockIdsOf(chunks), [[0, 1, 2, 3]]);
});

test("Breaks mark sections when the classifier kept the separators", () => {
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "---", "other", "primary"),
      sampleBlock(1, "sides", "pricing", "primary"),
      sampleBlock(2, "---", "other", "primary"),
      sampleBlock(3, "fries", "pricing", "primary", [4]),
      sampleBlock(4, "$5", "pricing", "primary", [3]),
    ],
  });

  assert.deepEqual(blockIdsOf(chunks), [[3, 4]]);
  assert.equal(chunks[0]?.sectionTitle, "sides");
});

// Pricing relationships

test("Consecutive products without separators stay separate", () => {
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "Tea", "pricing", "primary", [1, 2, 3]),
      sampleBlock(1, "$3", "pricing", "primary", [0]),
      sampleBlock(2, "Green or black", "pricing", "primary", [0]),
      sampleBlock(3, "Large$4", "pricing", "primary", [0]),
      sampleBlock(4, "Coffee", "pricing", "primary", [5, 6]),
      sampleBlock(5, "$4", "pricing", "primary", [4]),
      sampleBlock(6, "Dark roast", "pricing", "primary", [4]),
    ],
  });

  // Prices, descriptions, and options stay with their own product.
  assert.deepEqual(blockIdsOf(chunks), [
    [0, 1, 2, 3],
    [4, 5, 6],
  ]);
});

test("An over-linked block does not chain two products together", () => {
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "Soup", "pricing", "primary", [1]),
      sampleBlock(1, "$4", "pricing", "primary", [0, 2]),
      // The classifier also linked this product name to Soup's price.
      sampleBlock(2, "Stew", "pricing", "primary", [1, 3]),
      sampleBlock(3, "$6", "pricing", "primary", [2]),
    ],
  });

  assert.deepEqual(blockIdsOf(chunks), [
    [0, 1],
    [2, 3],
  ]);
});

test("Options linked only to their item's price stay with the item", () => {
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "Soup", "pricing", "primary", [1]),
      sampleBlock(1, "$4", "pricing", "primary", [0, 2]),
      // Linked to the price, not to the item name.
      sampleBlock(2, "Add bread$1", "pricing", "primary", [1]),
      sampleBlock(3, "Add butter$1", "pricing", "primary", [1]),
      sampleBlock(4, "Stew", "pricing", "primary", [5]),
      sampleBlock(5, "$6", "pricing", "primary", [4, 6]),
      // The price lists its option; the option lists nothing back.
      sampleBlock(6, "Add rice$2", "pricing", "primary"),
    ],
  });

  assert.deepEqual(blockIdsOf(chunks), [
    [0, 1, 2, 3],
    [4, 5, 6],
  ]);
});

test("An option linked only to another option is split, never merged", () => {
  // Known limitation: this chain has the same shape as an over-linked next
  // item, so the second option is held apart. Nothing is lost or merged.
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "Soup", "pricing", "primary", [1]),
      sampleBlock(1, "$4", "pricing", "primary", [0, 2]),
      sampleBlock(2, "Add bread$1", "pricing", "primary", [1, 3]),
      sampleBlock(3, "Add butter$1", "pricing", "primary", [2]),
    ],
  });

  assert.deepEqual(blockIdsOf(chunks), [
    [0, 1],
    [2, 3],
  ]);
});

test("Descriptions linked only to their item's price stay with the item", () => {
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "Soup", "pricing", "primary", [1]),
      sampleBlock(1, "$4", "pricing", "primary", [0, 2]),
      sampleBlock(2, "Leek and potato.", "pricing", "primary", [1]),
      sampleBlock(3, "Stew", "pricing", "primary", [4]),
      sampleBlock(4, "$6", "pricing", "primary", [3, 5]),
      // Classified as a claim rather than pricing.
      sampleBlock(5, "Slow cooked all day.", "company_claim", "primary", [4]),
    ],
  });

  assert.deepEqual(blockIdsOf(chunks), [
    [0, 1, 2],
    [3, 4, 5],
  ]);
});

test("Two unrelated consecutive items stay separate", () => {
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "Soup", "pricing", "primary", [1]),
      sampleBlock(1, "$4", "pricing", "primary", [0, 2]),
      sampleBlock(2, "Add bread$1", "pricing", "primary", [1]),
      sampleBlock(3, "Stew", "pricing", "primary", [4]),
      sampleBlock(4, "$6", "pricing", "primary", [3, 5]),
      sampleBlock(5, "Add cheese$1", "pricing", "primary", [4]),
    ],
  });

  assert.deepEqual(blockIdsOf(chunks), [
    [0, 1, 2],
    [3, 4, 5],
  ]);
});

test("Over-linked blocks do not connect separate items", () => {
  // The next item's name is linked to the previous item's price, and its own
  // price links back only to it.
  const overLinkedName = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "Soup", "pricing", "primary", [1]),
      sampleBlock(1, "$4", "pricing", "primary", [0]),
      sampleBlock(2, "Stew", "pricing", "primary", [1]),
      sampleBlock(3, "$6", "pricing", "primary", [2]),
    ],
  });

  assert.deepEqual(blockIdsOf(overLinkedName), [
    [0, 1],
    [2, 3],
  ]);

  // The same, when only the later price lists the name that precedes it.
  const priceListsName = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "Soup", "pricing", "primary", [1]),
      sampleBlock(1, "$4", "pricing", "primary", [0, 2]),
      sampleBlock(2, "Stew", "pricing", "primary"),
      sampleBlock(3, "$6", "pricing", "primary", [2]),
    ],
  });

  assert.deepEqual(blockIdsOf(priceListsName), [
    [0, 1],
    [2, 3],
  ]);

  // An option linked to both items' prices is ambiguous. The prices must not
  // merge, and no block may be lost.
  const sharedOption = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "Soup", "pricing", "primary", [1]),
      sampleBlock(1, "$4", "pricing", "primary", [0, 2]),
      sampleBlock(2, "Add bread$1", "pricing", "primary", [1, 4]),
      sampleBlock(3, "Stew", "pricing", "primary", [4]),
      sampleBlock(4, "$6", "pricing", "primary", [3, 2]),
    ],
  });

  const soupPrice = sharedOption.find((chunk) => chunk.blockIds.includes(1));
  const stewPrice = sharedOption.find((chunk) => chunk.blockIds.includes(4));

  assert.ok(soupPrice);
  assert.ok(stewPrice);
  assert.notEqual(soupPrice.id, stewPrice.id);
  assert.deepEqual(
    sharedOption.flatMap((chunk) => chunk.blockIds),
    [0, 1, 2, 3, 4],
  );
});

test("A one-sided link to the first block still keeps an option", () => {
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      // Only Soup lists its price, only the bread option lists Soup.
      sampleBlock(0, "Soup", "pricing", "primary", [1]),
      sampleBlock(1, "$4", "pricing", "primary"),
      sampleBlock(2, "Add bread$1", "pricing", "primary", [0]),
    ],
  });

  assert.deepEqual(blockIdsOf(chunks), [[0, 1, 2]]);
});

test("Pricing blocks with no relationship data are not split apart", () => {
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "Starter plan", "pricing", "primary"),
      sampleBlock(1, "Includes one site.", "pricing", "primary"),
      sampleBlock(2, "Billed annually.", "pricing", "primary"),
    ],
  });

  assert.deepEqual(blockIdsOf(chunks), [[0, 1, 2]]);
});

test("Euro and pound price headings begin separate offers", () => {
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "Harbor Start", "pricing", "primary", [1]),
      sampleBlock(1, "### €30", "pricing", "primary", [0]),
      sampleBlock(2, "Harbor Plus", "pricing", "primary", [3]),
      sampleBlock(3, "### £40", "pricing", "primary", [2]),
    ],
  });

  assert.deepEqual(blockIdsOf(chunks), [
    [0, 1],
    [2, 3],
  ]);
});

// Decorative image cleanup

const star = (n: number) =>
  `![Google star ${n}](https://cdn.trustindex.io/assets/platform/Google/star.svg)`;

test("Trustindex star images are removed from search text only", () => {
  const blocks: Block[] = [
    sampleBlock(
      0,
      "Posted on Google",
      "customer_review",
      "context",
      [1, 2, 3, 4],
    ),
    sampleBlock(1, star(1), "customer_review", "context", [0]),
    sampleBlock(2, star(2), "customer_review", "context", [0]),
    sampleBlock(3, "Alex Moreno", "customer_review", "context", [0]),
    sampleBlock(4, "Great service.", "customer_review", "context", [0]),
  ];

  const [review, ...rest] = buildChunks({ sourceUrl, blocks });

  assert.ok(review);
  assert.equal(rest.length, 0);

  // Original evidence keeps every image.
  assert.match(review.text, /Google star 1/);
  assert.match(review.text, /Google star 2/);
  assert.match(review.text, /cdn\.trustindex\.io/);

  // The same-role blocks are searchable, minus the decorative markup.
  assert.equal(
    review.searchText,
    "Posted on Google\n\nAlex Moreno\n\nGreat service.",
  );
});

test("A decorative image cut by segmentation leaves no markup in search text", () => {
  const image = star(1);
  const oversized = `${"x".repeat(1390)}${image}${" tail".repeat(300)}`;

  const chunks = buildChunks({
    sourceUrl,
    blocks: [sampleBlock(0, oversized, "customer_review", "context")],
  });

  assert.ok(chunks.length >= 2);

  // The control: the image really is cut across two segments.
  const start = oversized.indexOf(image);
  const end = start + image.length;
  const boundary = chunks[0]?.text.length ?? 0;
  assert.ok(start < boundary && boundary < end);

  // Evidence is untouched.
  assert.equal(chunks.map((chunk) => chunk.text).join(""), oversized);

  for (const chunk of chunks) {
    assert.doesNotMatch(chunk.searchText, /!\[|trustindex|star 1\]/);
  }

  // Everything else is still searchable.
  assert.match(chunks[0]?.searchText ?? "", /^x{1390}$/);
  assert.match(chunks.at(-1)?.searchText ?? "", /tail/);
});

test("Only known decorative markup is cleaned from search text", () => {
  const [chunk] = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "Our menu", "other", "context", [1]),
      sampleBlock(
        1,
        "![Menu photo](https://example.test/menu.jpg)",
        "other",
        "context",
        [0],
      ),
    ],
  });

  assert.ok(chunk);
  assert.match(chunk.searchText, /Menu photo/);
});

test("A chunk with nothing searchable is kept as evidence but not embeddable", () => {
  const [chunk, ...rest] = buildChunks({
    sourceUrl,
    blocks: [sampleBlock(0, star(1), "other", "context")],
  });

  assert.ok(chunk);
  assert.equal(rest.length, 0);

  assert.equal(chunk.text, star(1));
  assert.deepEqual(chunk.blockIds, [0]);
  assert.equal(chunk.searchText, "");
  assert.equal(chunk.embeddable, false);

  const [normal] = buildChunks({
    sourceUrl,
    blocks: [sampleBlock(0, "Open daily.", "company_claim", "primary")],
  });

  assert.equal(normal?.embeddable, true);
});

// Section titles

test("Section titles do not leak into unrelated content", () => {
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "* * *", "interface_noise", "excluded"),
      sampleBlock(1, "sides", "pricing", "primary"),
      sampleBlock(2, "* * *", "interface_noise", "excluded"),
      sampleBlock(3, "fries", "pricing", "primary", [4]),
      sampleBlock(4, "$5", "pricing", "primary", [3]),
      sampleBlock(5, "* * *", "interface_noise", "excluded"),
      sampleBlock(6, "## Contact us", "contact", "primary", [7]),
      sampleBlock(7, "Call 555-0100", "contact", "primary", [6]),
      sampleBlock(8, "Posted on Google", "customer_review", "context", [9]),
      sampleBlock(9, "Great food.", "customer_review", "context", [8]),
      sampleBlock(10, "* * *", "interface_noise", "excluded"),
      // Priced content with no label of its own.
      sampleBlock(11, "mug", "pricing", "primary", [12]),
      sampleBlock(12, "$9", "pricing", "primary", [11]),
    ],
  });

  assert.deepEqual(blockIdsOf(chunks), [
    [3, 4],
    [6, 7],
    [8, 9],
    [11, 12],
  ]);

  assert.equal(chunks[0]?.sectionTitle, "sides");

  for (const chunk of chunks.slice(1)) {
    assert.equal("sectionTitle" in chunk, false);
    assert.equal("sectionBlockId" in chunk, false);
    assert.doesNotMatch(chunk.searchText, /sides/);
  }
});

test("A major heading ends the section label's scope", () => {
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "* * *", "interface_noise", "excluded"),
      sampleBlock(1, "sides", "pricing", "primary"),
      sampleBlock(2, "* * *", "interface_noise", "excluded"),
      sampleBlock(3, "fries", "pricing", "primary", [4]),
      sampleBlock(4, "$5", "pricing", "primary", [3]),
      sampleBlock(5, "* * *", "interface_noise", "excluded"),
      sampleBlock(6, "## Catering trays", "pricing", "primary", [7]),
      sampleBlock(7, "Serves ten$90", "pricing", "primary", [6]),
    ],
  });

  assert.deepEqual(blockIdsOf(chunks), [
    [3, 4],
    [6, 7],
  ]);
  assert.equal(chunks[0]?.sectionTitle, "sides");

  for (const chunk of chunks.slice(1)) {
    assert.equal("sectionTitle" in chunk, false);
    assert.doesNotMatch(chunk.searchText, /sides/);
  }

  // A short label that introduces a heading starts a new section too.
  const labeled = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "* * *", "interface_noise", "excluded"),
      sampleBlock(1, "sides", "pricing", "primary"),
      sampleBlock(2, "* * *", "interface_noise", "excluded"),
      sampleBlock(3, "fries", "pricing", "primary", [4]),
      sampleBlock(4, "$5", "pricing", "primary", [3]),
      sampleBlock(5, "Party trays", "pricing", "primary", [6]),
      sampleBlock(6, "## Dessert trays", "pricing", "primary", [5, 7]),
      sampleBlock(7, "Serves ten$60", "pricing", "primary", [6]),
    ],
  });

  assert.deepEqual(blockIdsOf(labeled), [
    [3, 4],
    [5, 6, 7],
  ]);
  assert.equal(labeled[0]?.sectionTitle, "sides");
  assert.equal("sectionTitle" in (labeled[1] ?? {}), false);
});

test("Unlabeled items after a break still inherit the section label", () => {
  // Known limitation: without a heading, a later priced item cannot be told
  // apart from another item of the labeled section.
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "* * *", "interface_noise", "excluded"),
      sampleBlock(1, "sides", "pricing", "primary"),
      sampleBlock(2, "* * *", "interface_noise", "excluded"),
      sampleBlock(3, "fries", "pricing", "primary", [4]),
      sampleBlock(4, "$5", "pricing", "primary", [3]),
      sampleBlock(5, "* * *", "interface_noise", "excluded"),
      sampleBlock(6, "mug", "pricing", "primary", [7]),
      sampleBlock(7, "$9", "pricing", "primary", [6]),
    ],
  });

  assert.deepEqual(blockIdsOf(chunks), [
    [3, 4],
    [6, 7],
  ]);
  assert.equal(chunks[1]?.sectionTitle, "sides");
});

test("A new section label replaces the previous one", () => {
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "* * *", "interface_noise", "excluded"),
      sampleBlock(1, "sides", "pricing", "primary"),
      sampleBlock(2, "* * *", "interface_noise", "excluded"),
      sampleBlock(3, "fries", "pricing", "primary", [4]),
      sampleBlock(4, "$5", "pricing", "primary", [3]),
      sampleBlock(5, "* * *", "interface_noise", "excluded"),
      sampleBlock(6, "drinks", "pricing", "primary"),
      sampleBlock(7, "* * *", "interface_noise", "excluded"),
      sampleBlock(8, "lemonade", "pricing", "primary", [9]),
      sampleBlock(9, "$4", "pricing", "primary", [8]),
    ],
  });

  assert.deepEqual(
    chunks.map((chunk) => [
      chunk.blockIds,
      chunk.sectionTitle,
      chunk.sectionBlockId,
    ]),
    [
      [[3, 4], "sides", 1],
      [[8, 9], "drinks", 6],
    ],
  );
});

test("A section label with no content after it is kept, not discarded", () => {
  // Followed directly by another label.
  const replaced = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "* * *", "interface_noise", "excluded"),
      sampleBlock(1, "sides", "pricing", "primary"),
      sampleBlock(2, "* * *", "interface_noise", "excluded"),
      sampleBlock(3, "drinks", "pricing", "primary"),
      sampleBlock(4, "* * *", "interface_noise", "excluded"),
      sampleBlock(5, "lemonade", "pricing", "primary", [6]),
      sampleBlock(6, "$4", "pricing", "primary", [5]),
    ],
  });

  assert.deepEqual(blockIdsOf(replaced), [[1], [5, 6]]);
  assert.equal("sectionTitle" in (replaced[0] ?? {}), false);
  assert.equal(replaced[1]?.sectionTitle, "drinks");
  assert.deepEqual(
    replaced.map((chunk) => chunk.id),
    [0, 1],
  );

  // Last block in the document.
  const trailing = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "* * *", "interface_noise", "excluded"),
      sampleBlock(1, "sides", "pricing", "primary"),
      sampleBlock(2, "* * *", "interface_noise", "excluded"),
    ],
  });

  assert.deepEqual(blockIdsOf(trailing), [[1]]);
  assert.equal(trailing[0]?.text, "sides");
});

// Other structure

test("A short label before a heading starts a section with that heading", () => {
  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "Intro text", "company_claim", "primary"),
      sampleBlock(1, "Our services", "company_claim", "primary"),
      sampleBlock(2, "## Services", "company_claim", "primary", [3]),
      sampleBlock(3, "We help.", "company_claim", "primary", [2]),
    ],
  });

  assert.deepEqual(blockIdsOf(chunks), [[0], [1, 2, 3]]);
});

// Chunk safety

test("An oversized block becomes ordered segments that rebuild the original", () => {
  const paragraph =
    "Every sentence here ends cleanly and stays readable. ".repeat(10);
  const oversized = Array.from({ length: 8 }, () => paragraph).join("\n\n");

  assert.ok(oversized.length > MAX_CHARS * 2);

  const chunks = buildChunks({
    sourceUrl,
    blocks: [
      sampleBlock(0, "Before.", "company_claim", "primary"),
      sampleBlock(1, oversized, "company_claim", "primary"),
      sampleBlock(2, "After.", "company_claim", "primary"),
    ],
  });

  const segments = chunks.filter((chunk) => chunk.blockIds.includes(1));

  assert.ok(segments.length >= 3);
  assert.equal(chunks.length, segments.length + 2);

  // Neighbors are not merged into a segment.
  assert.deepEqual(chunks[0]?.blockIds, [0]);
  assert.deepEqual(chunks.at(-1)?.blockIds, [2]);

  for (const [index, segment] of segments.entries()) {
    assert.deepEqual(segment.blockIds, [1]);
    assert.deepEqual(segment.segment, { index, count: segments.length });
    assert.ok(segment.text.length <= MAX_CHARS);
    assert.ok(segment.embeddable);
  }

  // No source text is lost or altered.
  assert.equal(segments.map((segment) => segment.text).join(""), oversized);

  // Chunk ids stay sequential.
  assert.deepEqual(
    chunks.map((chunk) => chunk.id),
    chunks.map((_, index) => index),
  );

  // Ordinary chunks carry no segment marker.
  assert.equal("segment" in (chunks[0] ?? {}), false);
});

test("splitOversizedText prefers paragraph, then sentence, then hard cuts", () => {
  const lone = (text: string) => splitOversizedText(text);

  assert.deepEqual(lone("short"), ["short"]);

  const paragraphs = `${"a".repeat(900)}\n\n${"b".repeat(900)}`;
  assert.deepEqual(lone(paragraphs), [
    `${"a".repeat(900)}\n\n`,
    "b".repeat(900),
  ]);

  const sentences = "Word word word. ".repeat(200);
  const bySentence = lone(sentences);
  assert.ok(bySentence.length > 1);
  assert.ok(bySentence.slice(0, -1).every((piece) => piece.endsWith(". ")));
  assert.equal(bySentence.join(""), sentences);

  const unbroken = "x".repeat(3000);
  assert.deepEqual(
    lone(unbroken).map((piece) => piece.length),
    [1400, 1400, 200],
  );
});

test("splitOversizedText never splits a surrogate pair", () => {
  const emoji = "😀".repeat(1000);
  const pieces = splitOversizedText(emoji, 1401);

  assert.equal(pieces.join(""), emoji);

  for (const piece of pieces) {
    assert.ok(piece.length <= 1401);
    assert.doesNotMatch(
      piece,
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    );
  }
});

test("Ordinary blocks never produce a chunk over the size limit", () => {
  const blocks = Array.from({ length: 12 }, (_, id) =>
    sampleBlock(id, `${id}: ${"w".repeat(300)}`, "company_claim", "primary"),
  );

  const chunks = buildChunks({ sourceUrl, blocks });

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text.length <= MAX_CHARS));
  assert.deepEqual(
    chunks.flatMap((chunk) => chunk.blockIds),
    blocks.map((b) => b.id),
  );
});

test("Every retained block is traceable and excluded blocks never appear", () => {
  const blocks: Block[] = [
    sampleBlock(0, "top of page", "interface_noise", "excluded"),
    sampleBlock(1, "---", "other", "primary"),
    sampleBlock(2, "sides", "pricing", "primary"),
    sampleBlock(3, "---", "other", "primary"),
    sampleBlock(4, "fries", "pricing", "primary", [5]),
    sampleBlock(5, "$5", "pricing", "primary", [4]),
    sampleBlock(
      6,
      "![Leaf](https://example.test/leaf.svg)",
      "other",
      "context",
      [4],
    ),
    sampleBlock(7, "Posted on Google", "customer_review", "context", [8]),
    sampleBlock(8, "Great food.", "customer_review", "context", [7]),
    sampleBlock(9, "Read more", "interface_noise", "excluded"),
    sampleBlock(10, "Open daily.", "company_claim", "primary"),
  ];

  const chunks = buildChunks({ sourceUrl, blocks });

  const traced = [
    ...chunks.flatMap((chunk) => chunk.blockIds),
    ...chunks.flatMap((chunk) =>
      chunk.sectionBlockId === undefined ? [] : [chunk.sectionBlockId],
    ),
  ];

  // Retained blocks, minus separators; the section label is a metadata
  // reference.
  assert.deepEqual(
    [...new Set(traced)].sort((a, b) => a - b),
    [2, 4, 5, 6, 7, 8, 10],
  );

  for (const excluded of [0, 1, 3, 9]) {
    assert.ok(!traced.includes(excluded));
  }
});

test("Duplicate block ids are rejected", () => {
  assert.throws(
    () =>
      buildChunks({
        sourceUrl,
        blocks: [
          sampleBlock(0, "first", "other", "primary"),
          sampleBlock(0, "second", "other", "primary"),
        ],
      }),
    /Duplicate block id 0/,
  );
});

test("No blocks produce no chunks", () => {
  assert.deepEqual(buildChunks({ sourceUrl, blocks: [] }), []);
});
