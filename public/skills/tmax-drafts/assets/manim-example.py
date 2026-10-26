"""Manim Community 0.22: a short, TeX-free area explanation using MathTypst."""
from manim import (
    Scene, MathTypst, VGroup, Rectangle, FadeIn, Write, TransformMatchingShapes,
    UP, DOWN, LEFT, RIGHT,
)


class SquareExpansion(Scene):
    def construct(self):
        self.camera.background_color = "#fdf6e3"
        ink, blue, yellow, green = "#073642", "#268bd2", "#b58900", "#859900"
        a, b = 2.0, 1.2
        # A literal partition: two ab rectangles, one a² and one b² square.
        blocks = VGroup()
        labels = VGroup()
        for width, height, x, y, formula, color in [
            (a, a, 0, b, "a^2", blue),
            (b, a, a, b, "a b", yellow),
            (a, b, 0, 0, "a b", yellow),
            (b, b, a, 0, "b^2", green),
        ]:
            rect = Rectangle(width=width, height=height, color=ink,
                             fill_color=color, fill_opacity=0.24, stroke_width=2)
            rect.move_to([x + width / 2, y + height / 2, 0])
            blocks.add(rect)
            labels.add(MathTypst(formula, color=ink, font_size=38).move_to(rect))
        diagram = VGroup(blocks, labels).move_to(LEFT * 2.8)
        side = MathTypst("a + b", color=ink, font_size=38).next_to(diagram, DOWN)
        first = MathTypst("(a + b)^2", color=ink, font_size=44).move_to(RIGHT * 2.5 + UP)
        expanded = MathTypst("a^2 + a b + a b + b^2", color=ink, font_size=36).move_to(first)
        simplified = MathTypst("a^2 + 2 a b + b^2", color=ink, font_size=40).move_to(first)
        self.play(FadeIn(blocks), Write(side), Write(first))
        self.wait(1)
        self.play(Write(labels), TransformMatchingShapes(first, expanded), run_time=2)
        self.wait(2)
        self.play(TransformMatchingShapes(expanded, simplified), run_time=2)
        self.wait(3)
