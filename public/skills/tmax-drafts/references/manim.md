# Mathematics in a Draft

Manim is the Python animation engine started by Grant Sanderson (3Blue1Brown).
Use **Manim Community**, imported as `manim`, for this workflow. The original
`3b1b/manim` now uses ManimGL (`manimgl` / `manimlib`); do not mix their APIs or
installation instructions. Manim renders media before publication; it does not
run inside the Draft's browser iframe.

## Choose what helps the explanation

Use Manim for stepwise equation changes, vectors, transformations, graphs,
geometry, limits and other ideas where the change itself matters. State the
question, define symbols and assumptions, show one change at a time, and connect
it to the conclusion. Keep a quantity's color and label consistent. Use short
clips with readable pauses, not a long decorative intro.

For a static identity, use selectable DOM text or MathML. For parameters the
reader must change, use inline JavaScript and SVG/canvas in the HTML; a Manim
video is not an interactive calculator. Keep essential formulas, steps and
conclusions as selectable HTML beside the animation so the user can comment on
them. Do not make the video the only explanation.

## Render in an isolated environment

Reuse a working Community environment when available. Otherwise create a local
project environment, leaving agent/system Python packages alone:

```sh
uv init --python 3.12 math-animation
cd math-animation
uv add 'manim[typst]==0.22.0'
uv run manim checkhealth
```

The bundled example targets Community 0.22.0. Keep the environment lockfile with
the scene source. macOS needs Cairo and pkg-config (`brew install cairo
pkg-config` when missing). Linux may also need a compiler, Python headers,
Cairo/Pango headers and pkg-config; consult the official installation guide for
the machine's distribution. Install rendering dependencies only on the machine
doing the render, not across the fleet just because the Skill was installed.

`MathTex`/`Tex` require a working LaTeX installation and `dvisvgm`.
Use `MathTex` with `TransformMatchingTex` when matching named equation terms;
isolate terms explicitly and check the correspondence visually. Community's
`MathTypst` is an alternative when TeX is unavailable: the `[typst]` extra
includes its compiler. Typst math has its own syntax, not LaTeX syntax.
`TransformMatchingShapes` matches glyph shapes, not mathematical meaning;
inspect transitions or explicitly animate terms when their identity matters.
For Chinese prose, use `Text` with an installed CJK font and check for missing
glyphs; put full explanations in the HTML.

Copy [assets/manim-example.py](../assets/manim-example.py) from this installed
Skill into the render project as `scene.py`, then render its `SquareExpansion`
scene (replace the names for your own scene):

```sh
uv run manim -ql --renderer=cairo --format=mp4 --media_dir ./media scene.py SquareExpansion
# After inspecting the preview, make the delivery version:
uv run manim -qm --renderer=cairo --format=mp4 --media_dir ./media scene.py SquareExpansion
```

Use the output path reported by Manim. The preview is 480p; `-qm` is 720p.
Avoid `-p` on remote machines since it launches a local media player. Keep scene
source and the render command for revisions. If dependencies prevent rendering,
report the specific missing dependency and provide a useful static/interactive
HTML explanation; do not claim that a video was rendered.

## Include the result in the Draft

Upload the rendered MP4 through this Skill's `scripts/upload-asset.mjs`, using
the existing local `~/.config/tmux-mobile/draft-assets.json`. Follow the static
media section of `SKILL.md`; do not put credentials or base64 video into HTML.
Use the uploader's exact returned URL:

```html
<figure>
  <video controls playsinline preload="metadata"
         aria-label="How the area gives the square expansion"
         src="RETURNED_URL" style="display:block;width:100%;height:auto"></video>
  <figcaption>Splitting a square of side a + b gives a² + 2ab + b².</figcaption>
</figure>
<p>For a, b ≥ 0, the two rectangles each have area ab.
Their combined area explains the middle term: (a + b)² = a² + 2ab + b².</p>
```

Let the reader start, pause and replay; do not autoplay. Add captions or an HTML
transcript if narration carries information. A poster, if used, must also go
through the asset uploader. Adapt the scene palette to the document and check
legibility at phone width. Keep text large and avoid dense full-screen equations.

Inspect the actual preview for correct mathematics, matched terms, cropping,
font glyphs and pacing. After normal Draft publication, verify that the managed
video loads and plays in the viewer, seeking works, and adjacent explanation
text is selectable for comments. Upload success alone is not playback proof.

## Official references

- [Community installation](https://docs.manim.community/en/stable/installation/uv.html)
- [Quickstart and rendering](https://docs.manim.community/en/stable/tutorials/quickstart.html)
- [Text, LaTeX and Typst](https://docs.manim.community/en/stable/guides/using_text.html)
- [TransformMatchingTex](https://docs.manim.community/en/stable/reference/manim.animation.transform_matching_parts.TransformMatchingTex.html)
- [Original project and edition differences](https://github.com/3b1b/manim)
