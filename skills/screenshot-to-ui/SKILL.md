---
name: screenshot-to-ui
description: "Generates UI components or full layouts from a design source — screenshot, URL, or HTML file. Two-phase workflow: build a JSONC design spec, then generate framework-aware code from the spec. Use when the user provides a screenshot, a link to a web page, or an HTML file and asks to recreate/clone/turn it into code."
---

# Screenshot / URL / HTML → UI Code

Two-phase workflow:

1. **Phase 1 — Build the spec**: analyze the design source and produce a JSONC spec file: `ui-spec.jsonc` in the project (or path the user gives).
2. **Phase 2 — Generate code**: read the spec + the project stack, generate components/layout in the project's framework, styles, and theme.

Always show the user the spec after Phase 1 and offer to adjust it before code generation. The spec is a reviewable artifact: hand-edits to it are the intended way to fix colors, texts, or structure without re-analyzing the source.

**Vision requirement**: the screenshot pipeline requires a vision-capable model. If the current model cannot see images, tell the user and suggest switching models (or use the HTML/URL pipeline if the source is available as markup).

## Phase 1 — pick the pipeline by source

### A. Screenshot (image file or image attached to message)

1. Read the image. Note the assumed viewport width (if unknown, assume 1440px desktop unless the layout is clearly mobile).
2. Extract:
   - **Text** — transcribe literally. Mark any uncertain OCR text in the spec with `// !ocr` comment.
   - **Colors** — best-effort hex values; round to clean values when they look intentional.
   - **Typography** — relative scale (sizes, weights, line-heights in CSS px). If the screenshot is 2x/retina, normalize all dimensions to CSS px (÷2).
   - **Layout structure** — semantic roles (`header`, `nav`, `hero`, `card`, `footer`...), not a dump of divs. Detect the flex/grid pattern per container.
   - **Repeating blocks** — mark as components with variant list.
   - **Images/icons** — crop/save them into `ui-assets/` in the project (or ask the user where to put them); reference by id in the spec. If a tool can't crop, reference the source region in a `notes` entry.
   - **Responsive hints** — breakpoints you can infer (column counts, stacking), otherwise note `assume: mobile-first, 2 breakpoints`.
3. Write the JSONC spec following the schema in [references/spec-format.md](references/spec-format.md).

Uncertainties go into `notes` — never silently guess a visible label or CTA.

### B. HTML file (local file or pasted markup)

Do NOT route through vision. Parse the markup directly:

1. Read the file. Extract DOM tree, inline styles, class names, and any embedded `<style>` blocks.
2. If classes reference external CSS that is available in the project, read it too.
3. Map the DOM into the spec with the same structure as pipeline A, but:
   - use exact values from the CSS (colors, fonts, spacing) — these are ground truth, no `!ocr`/`!guess` needed;
   - keep semantic roles from existing tags (`header`, `nav`, `main`, `article`, ...);
   - if the HTML is unstyled (structure only), say so in `meta.source_notes` and treat layout as inference.
4. Same spec output.

### C. URL (web page link)

Hybrid — markup is the source of truth, vision is QA:

1. Fetch the HTML (`web_fetch` or `curl`) and the main CSS file(s) (parse `<link rel="stylesheet">`).
2. Download key assets (logos, hero images) into `ui-assets/`.
3. Build the spec from DOM + CSS like pipeline B.
4. **Optional QA**: if a screenshot of the live page is available (user provides it, or you can render it), compare against the spec. If they conflict, trust CSS values and record the discrepancy in `notes`.
5. Note in `meta`: fetch date and that the page may use JS-rendered content that static fetch misses — if the fetched HTML looks empty/bare, tell the user and ask for a screenshot instead.

## Phase 2 — Generate code from the spec

Work through these steps in order, and say which step you're on:

1. **Detect the stack.** Read `package.json` (or equivalent), list existing components, and determine:
   - framework (React / Vue / Svelte / Solid / plain HTML...),
   - styling approach (Tailwind / CSS Modules / CSS-in-JS / plain CSS / UI kit),
   - existing UI kit and its components (shadcn, MUI, Ant Design, ...),
   - theme system (CSS variables, Tailwind config, theme file) and dark-mode handling,
   - **the project's breakpoint scale** — Tailwind config (`tailwind.config.*`, or `@theme`/`--breakpoint-*` in CSS for Tailwind v4), CSS variables like `--bp-*` / media queries in existing stylesheets, or the UI kit's grid breakpoints (MUI `xs/sm/md/lg/xl`, Ant Design `Grid`, Bootstrap `sm/md/lg/xl/xxl`),
   - the project's container/max-width convention (container token, wrapper class, or recurring max-width values in existing CSS),
   - file conventions (where components live, naming, one-component-per-file).
   If no breakpoint scale exists in the project, default to `sm 480 / md 768 / lg 1024 / xl 1280` and create the tokens so the scale exists for future work. Summarize findings in 2–3 lines before generating, including the breakpoint scale you will use.

2. **Map design tokens.** Translate `spec.designTokens` into the project's token system:
   - if the project has a theme → extend/override its tokens, don't create a parallel system;
   - if no theme exists → emit CSS variables (or Tailwind config entries) for the spec's tokens.
   Never hardcode spec hex values scattered through components — always via tokens.

3. **Generate components first.** For each entry in `spec.components`: one file, following project conventions, with the variants the spec lists. **Prefer reusing an existing project/UI-kit component when one is close enough** — adapt it instead of writing a new one. Record substitutions in a short summary ("used project's Button instead of generating one").

4. **Compose the layout.** Build `spec.layout` as page/section files composing the components. Preserve the DOM order and roles from the spec.

5. **Wire assets.** Reference files from `ui-assets/` per project convention (public dir, imports).

6. **Responsive pass — adaptive, not rubbery.** The generated layout must consist of discrete breakpoint-based variants on bounded content width, not fluid stretching:
   - Use **only the project's breakpoint scale** from step 1. If `spec.responsive.breakpoints` differ from the project scale, snap the spec's behavior onto the nearest project breakpoints and note the mapping in the summary.
   - Mobile-first: base styles = narrowest layout (single-column stack); add `sm:`/`md:`/`lg:` (or `@media (min-width: ...)`) per step up to the design width. Column counts and stacking change **only at declared breakpoints**; between breakpoints the layout is stable.
   - **Bounded content width:** every major content block lives in a max-width container (the project's container token from step 1, or the measured design width rounded to a clean value, e.g. 1200px) and is centered. Content must not stretch edge-to-edge as the viewport grows.
   - **No rubbery patterns** for content: no uncapped `1fr`/`auto` text columns, no `width: 100%` blocks whose size tracks the viewport, no `vw`/`clamp()`-scaled typography or spacing — unless that is already an established project convention. Grid tracks that do stretch are allowed only for intentional bleed areas (full-bleed backgrounds, hero sections), with the inner content still bounded.
   - Derive the collapse behavior from the single design width: e.g. a 3-column card row becomes 2 columns below `lg` and a stack below `md`; nav links collapse to a burger below the breakpoint where they stop fitting. Record these derived rules in the summary so the user can adjust them.

7. **Self-check.** Re-read the generated code against the spec and list: (a) spec entries not implemented, (b) decisions you made beyond the spec, (c) `!ocr`/`!guess` items the user should verify, (d) which breakpoint each layout change happens at. If the user can run the project, suggest a visual diff against the original source.

## Rules

- One component per file, project's naming style.
- No fabricated content: every visible string comes from the spec; placeholders only where the spec marks them `!placeholder`.
- Don't add features, animations, or interactivity the source doesn't show.
- **Adaptive, not rubbery:** content is laid out on the project's breakpoints inside a bounded, centered container. Layout changes happen at declared breakpoints only; nothing in the content track should grow fluidly with the viewport.
- Keep the spec file in the project after generation — it documents the design and enables re-generation.
- If the source is a full marketing/landing page, confirm scope with the user (whole page vs one section) before generating.

## Spec format

See [references/spec-format.md](references/spec-format.md) for the full schema and a worked example.
