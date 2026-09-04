# Progressive visual explanations

A visual must teach something that prose or a short list would make harder to understand.

## Build flows progressively

When a behavior has three or more moving parts, draw a short series. Each figure redraws the previous one and adds one idea.

For `A → B → C` with a return edge:

1. Draw `A → B` and explain that relationship.
2. Redraw it, add `C`, and explain the new step.
3. Redraw it, add the return edge or failure path, and explain the completed behavior.

Do not replace the sequence with one crowded diagram at the end. A complete overview may follow as a reference after the build-up.

## Choose the medium

- Use Mermaid for flows, state changes, dependencies, and structures whose labels carry the meaning.
- Use the diff, code, logs, test output, or debugger when concrete evidence explains the change best.
- Use an image-generation tool for spatial ideas such as layout, overlap, scroll position, or visual before/after states. Request a marker-on-whiteboard style and only a few short labels.
- Use no figure for one simple point.

Generated raster images may live in temporary storage and be shown in the wrap-up tab. If the environment lacks an image-generation tool, say so and use the clearest available non-raster evidence; do not pretend an image was generated. Persist a visual only when the project needs it in durable documentation or the eventual pull request.
