# Kuzmich --- UI Design System

## Purpose

Use this document as the visual design source of truth when building or
modifying the **Kuzmich** application. Keep the interface consistent
with the existing dark workspace and the
engineering-brutalist brand direction.

The product should feel like a capable engineering tool: practical,
controlled, precise, and quietly distinctive. Avoid generic "AI product"
visual clichés.

## Brand direction

-   **Style:** engineering brutalism, restrained industrial design.
-   **Personality:** experienced technical master / coordinator who
    keeps multiple agents and sessions organized.
-   **Visual principles:** strong geometry, compact layouts, clear
    hierarchy, minimal decoration, functional details.
-   **Do not use:** neon gradients, glowing effects, excessive rounded
    cards, decorative circuit patterns, robot-head mascots, generic gear
    icons, or unnecessary animation.
-   Prefer square or slightly rounded corners, thin borders, dense but
    readable information, and purposeful spacing.

## Color palette

Use these values as the starting palette. If the existing application
already has equivalent design tokens, map these values to those tokens
rather than introducing duplicate colors.

  -----------------------------------------------------------------------
  Token                   Hex                     Use
  ----------------------- ----------------------- -----------------------
  `bg-primary`            `#171A19`               Main application
                                                  background

  `bg-surface`            `#232826`               Panels, sidebars, input
                                                  areas, elevated
                                                  surfaces

  `bg-surface-muted`      `#303A34`               Selected items,
                                                  restrained highlight
                                                  surfaces, logo tile

  `border-subtle`         `#3A413D`               Dividers, panel
                                                  borders, separators

  `accent-muted-green`    `#82968A`               Primary restrained
                                                  accent, selected
                                                  states, small emphasis

  `accent-green-soft`     `#9BB6A4`               Secondary accent for
                                                  small indicators and
                                                  active details

  `text-primary`          `#D5E0D8`               Main text and
                                                  high-contrast labels

  `text-secondary`        `#AAB4AD`               Supporting text

  `text-muted`            `#929D96`               Metadata, hints,
                                                  inactive labels
  -----------------------------------------------------------------------

### Color rules

1.  Keep the interface predominantly dark graphite.
2.  Use muted gray-green for emphasis, not as a large saturated fill
    across the whole interface.
3.  Maintain readable contrast for body text, controls, and focus
    states.
4.  Use the light text color sparingly for the strongest hierarchy.
5.  **Do not introduce orange as a brand accent.** The agreed direction
    is graphite, gray, and muted green.
6.  Avoid adding new colors unless a functional state requires them. For
    success, warning, and error states, use restrained, accessible
    variants that remain distinct from the brand accent.
7.  Never rely on color alone to communicate status; pair it with a
    label, icon, or other cue.

## Typography

### Brand / logo

-   Preferred display font: **Russo One**.
-   Use for the standalone wordmark "Кузьмич" and occasional short,
    high-impact headings only.
-   Preserve the exact Cyrillic spelling and capitalization:
    **Кузьмич**.
-   Do not use the display font for long text, tables, code, or dense
    interface controls.

### Application UI

-   Preferred UI font: **IBM Plex Sans**.
-   Use regular/medium weights for body text and semibold/bold for
    labels and headings.
-   Preferred monospace font: **IBM Plex Mono** for code, agent IDs,
    paths, command output, technical identifiers, and system status
    details.
-   Ensure Cyrillic glyphs render correctly. Provide sensible fallback
    fonts if the preferred fonts are unavailable.
-   Do not simulate bold by distorting glyphs or apply excessive letter
    spacing to Cyrillic text.

### Typography hierarchy

-   Page title: IBM Plex Sans semibold/bold.
-   Section title: IBM Plex Sans medium/semibold.
-   Body and controls: IBM Plex Sans regular/medium.
-   Technical metadata: IBM Plex Mono, used selectively.
-   Wordmark: Russo One.

## Logo concept

The logo should combine a strong wordmark with a compact geometric
symbol.

-   **Wordmark:** "Кузьмич" in Russo One.
-   **Symbol direction:** a square, technical monogram or abstract
    intersecting geometry suggesting coordination and structure.
-   The symbol should work at small sizes, including a 32 × 32 px app
    icon.
-   Use simple strokes and a small number of shapes. Keep the symbol
    recognizable in monochrome.
-   A square frame is acceptable, with subtle interruptions or offsets
    that suggest a constructed technical object.
-   Avoid literal robot heads, brains, gears, and overly complicated
    circuitry.
-   Do not treat the concept sketch as a finalized vector logo; refine
    it for balance, legibility, and small-size rendering before
    shipping.

## Layout and components

-   Favor compact, tool-oriented layouts over spacious marketing-page
    layouts.
-   Use consistent alignment and spacing.
-   Prefer square or subtly rounded corners over pill-shaped containers.
-   Use thin, low-contrast borders to separate adjacent work areas.
-   Use surfaces to establish hierarchy rather than heavy shadows.
-   Reserve the accent color for active navigation, selected controls,
    small indicators, and key actions.
-   Keep buttons and controls visually clear, with distinct hover,
    pressed, disabled, and keyboard-focus states.
-   Tables, logs, agent lists, command output, and technical details
    should remain easy to scan.
-   Avoid unnecessary cards nested inside cards.
-   Do not sacrifice accessibility or readability for visual density.

## Interaction and motion

-   Motion should be brief and functional, helping users understand
    state changes.
-   Avoid decorative animations, pulsing glows, and continuous movement.
-   Provide visible keyboard-focus indicators.
-   Maintain consistent hover and selected states.
-   Disabled controls must be distinguishable from active controls
    without becoming unreadable.

## Implementation guidance for the AI agent

Before changing UI: 1. Inspect the existing component structure, styling
system, and design tokens. 2. Reuse existing components and tokens where
possible; avoid creating parallel styling systems. 3. Check how fonts
are loaded and whether Cyrillic support is complete. 4. Make the
smallest coherent change that follows this guide. 5. Preserve existing
functionality and application behavior.

When implementing: - Prefer centralized CSS variables or theme tokens
for palette values. - Avoid scattering raw hex values through components
when the project has a token system. - Do not add a new dependency
solely for styling without a clear need. - Keep responsive behavior and
accessibility intact. - Ensure focus, hover, selected, disabled,
success, warning, and error states are styled. - Use the logo font only
where intended; keep normal application text in the UI font. - Do not
redesign unrelated screens just to apply the style guide.

Before finishing: - Review the result against the palette and typography
rules above. - Check key screens at the application's normal desktop
size and at a narrower viewport. - Verify that labels and the wordmark
render correctly in Cyrillic. - Confirm there are no unintended orange
accents, neon gradients, or generic AI visual clichés. - Report which
files/components were changed and any design-system gaps that remain.

## Acceptance checklist

-   [ ] Main surfaces use dark graphite tones.
-   [ ] Muted gray-green is the primary brand accent.
-   [ ] No orange brand accent has been introduced.
-   [ ] "Кузьмич" is spelled and capitalized correctly.
-   [ ] Russo One is used for the wordmark where available.
-   [ ] IBM Plex Sans is used for UI text and IBM Plex Mono for
    technical details where appropriate.
-   [ ] Cyrillic text renders correctly.
-   [ ] The geometric symbol remains legible at small sizes.
-   [ ] Components have visible interaction and keyboard-focus states.
-   [ ] Existing functionality and responsive behavior are preserved.

## Short instruction

When in doubt, prioritize **clarity, restraint, engineering precision,
and consistency** over decoration. Kuzmich should look like a serious
engineering tool with a distinct personality---not a generic AI
dashboard.
