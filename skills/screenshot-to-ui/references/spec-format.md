# UI Spec Format (JSONC)

The spec is a JSONC file (JSON with comments) produced in Phase 1 and consumed in Phase 2.
Comments are for humans: OCR uncertainty (`// !ocr`), guesses (`// !guess`), placeholders (`// !placeholder`), decisions.

## Top-level shape

```jsonc
{
  "meta": {
    "source": "screenshot" | "html" | "url",
    "source_ref": "path or URL of the original source",
    "viewport": "1440x900",          // assumed/known render width in CSS px
    "title": "Page title or short label",
    "fetched_at": "2025-01-01",      // for url source
    "source_notes": "optional free text (e.g. 'DOM parsed, CSS from styles.css', 'JS-rendered content may be missing')"
  },

  "designTokens": {
    "colors": {
      "bg": "#ffffff",
      "text": "#111827",
      "primary": "#2563eb",
      "primary-contrast": "#ffffff",
      "muted": "#6b7280",
      "border": "#e5e7eb",
      // name more as needed: accent, surface, danger, ...
    },
    "typography": {
      "font-family": { "sans": "'Inter', system-ui, sans-serif" },
      "scale": [                       // observed size steps, CSS px
        { "step": "xs",  "size": 12, "lineHeight": 16 },
        { "step": "sm",  "size": 14, "lineHeight": 20 },
        { "step": "md",  "size": 16, "lineHeight": 24 },
        { "step": "lg",  "size": 20, "lineHeight": 28 },
        { "step": "xl",  "size": 24, "lineHeight": 32 },
        { "step": "2xl", "size": 32, "lineHeight": 40 },
        { "step": "hero","size": 48, "lineHeight": 56 }
      ],
      "weights": [400, 500, 600, 700]  // observed weights
    },
    "spacing": [0, 4, 8, 12, 16, 24, 32, 48, 64],   // observed spacing steps
    "radii": { "sm": 6, "md": 8, "lg": 16, "full": 9999 },
    "shadows": { "card": "0 1px 3px rgba(0,0,0,0.1)" }   // only if observed
  },

  "layout": {                          // the page/section tree — semantic, not a div dump
    "type": "layout",                  // "layout" | "component"
    "role": "page",                    // semantic role: page, header, nav, hero, main, section, card, footer, ...
    "id": "page",                      // stable id, kebab-case
    "container": {                     // flex/grid pattern of this node (omit if just a block flow)
      "display": "flex" | "grid",
      "direction": "row" | "column",   // flex only
      "justify": "start|center|end|between",
      "align": "start|center|end|stretch",
      "gap": 24,
      "gridTemplate": "1fr 320px"       // grid only, if observed
    },
    "styles": { /* sparse overrides: maxWidth, padding, colors not covered by tokens */ },
    "text": null,                      // string for text nodes (mark with // !ocr if from screenshot)
    "component": "Card",               // if this node is an instance of a spec.components entry
    "componentProps": { "variant": "outlined" },
    "asset": "logo",                   // if this node is an image/icon from "assets"
    "children": [ /* nodes */ ]
  },

  "components": [                      // repeated/reusable blocks extracted from the layout
    {
      "name": "Card",
      "usedIn": ["features-1", "features-2", "features-3"],
      "structure": { /* mini layout tree for the component */ },
      "variants": [                    // observed usage variants
        { "name": "default", "diff": "no border" },
        { "name": "outlined", "diff": "1px border" }
      ]
    }
  ],

  "assets": [
    { "id": "logo",    "file": "ui-assets/logo.svg",  "alt": "Company logo", "usage": "nav" },
    { "id": "hero-img","file": "ui-assets/hero.png",  "alt": "...",          "usage": "hero" }
  ],

  "responsive": {
    "breakpoints": [{ "name": "md", "width": 768 }, { "name": "lg", "width": 1024 }],   // observed/inferred here; Phase 2 snaps them onto the project's breakpoint scale
    "behavior": [
      "nav collapses to burger below lg",      // only what is observed/inferred
      "feature cards stack below md"
    ],
    "confidence": "observed | inferred | assumed"
  },

  "notes": [
    "OCR uncertain: button label may be 'Get started' // !ocr",
    "hero image ratio looks 16:9 // !guess",
    "empty list items are placeholder content // !placeholder"
  ]
}
```

## Rules for the tree

- **Semantic roles, not structure dumps.** A `<div><div><div>` nesting becomes one node per meaningful region. If a wrapper exists only for layout (e.g. a centering container), it may be a `layout` node, but don't create nodes for pure styling.
- **Max useful depth is ~5.** Deeper trees mean you're describing divs, not design.
- **Repeat ≥2 → component.** If the same visual block appears multiple times, hoist it to `components` and reference with `"component": "Name"`.
- **Text nodes**: leaf nodes with `"text"`. Keep exact capitalization.
- **Sparse styles.** `styles` only carries what tokens don't cover (max-widths, specific paddings). No color/font-size in `styles` — those are tokens.
- **Everything measured in CSS px.** A 2x screenshot → divide by 2.

## Minimal worked example (screenshot → spec fragment)

```jsonc
{
  "meta": { "source": "screenshot", "viewport": "1440", "title": "SaaS landing — hero + features" },
  "designTokens": {
    "colors": { "bg": "#0b0f19", "text": "#f9fafb", "muted": "#9ca3af", "primary": "#6366f1", "border": "#1f2937" },
    "typography": { "font-family": { "sans": "system-ui, sans-serif" }, "scale": [
      { "step": "md", "size": 16, "lineHeight": 24 },
      { "step": "hero", "size": 56, "lineHeight": 64 } ] },
    "spacing": [8, 16, 24, 32, 64, 96],
    "radii": { "md": 8, "lg": 12 }
  },
  "layout": {
    "type": "layout", "role": "page", "id": "page",
    "container": { "display": "flex", "direction": "column", "gap": 96 },
    "children": [
      {
        "type": "layout", "role": "nav", "id": "nav",
        "container": { "display": "flex", "justify": "between", "align": "center", "gap": 32 },
        "styles": { "maxWidth": 1200, "padding": [16, 32] },
        "children": [
          { "asset": "logo" },
          { "type": "layout", "role": "nav-links", "children": [
            { "text": "Product" }, { "text": "Pricing" }, { "text": "Docs" }
          ] },
          { "component": "Button", "componentProps": { "variant": "primary" }, "text": "Sign up" }
        ]
      },
      {
        "type": "layout", "role": "hero", "id": "hero",
        "container": { "display": "flex", "direction": "column", "align": "center", "gap": 24 },
        "children": [
          { "text": "Ship faster with CI/CD", "styles": { "fontSize": "hero" } },
          { "text": "Deploy in one click. // !ocr", "styles": { "color": "muted", "fontSize": "md" } },
          { "component": "Button", "componentProps": { "variant": "primary" }, "text": "Get started" }
        ]
      }
    ]
  },
  "components": [
    {
      "name": "Button",
      "usedIn": ["nav", "hero"],
      "variants": [
        { "name": "primary", "diff": "primary bg, white text, radius md, padding 10x20" },
        { "name": "ghost",   "diff": "transparent, border, text color" }
      ]
    }
  ],
  "assets": [ { "id": "logo", "file": "ui-assets/logo.svg", "alt": "Logo", "usage": "nav" } ],
  "responsive": { "breakpoints": [{ "name": "lg", "width": 1024 }],
    "behavior": ["nav-links hidden below lg (burger presumed)"], "confidence": "inferred" },
  "notes": [ "tagline OCR uncertain // !ocr" ]
}
```
