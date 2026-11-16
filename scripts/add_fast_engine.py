"""Adds a WildbgFast class to wildbg's wasm bindings: the same API, but one-ply
(the plain neural net, no look-ahead). It is roughly 20-50x faster, which is
plenty for grading moves and the win-chance chart. The bot keeps the deep Wildbg."""
import re, sys
p = sys.argv[1]
src = open(p).read()
start = src.index("#[wasm_bindgen]\npub struct Wildbg {")
end = src.index("#[wasm_bindgen]\npub fn starting_position")
block = src[start:end]
fast = re.sub(r"\bWildbg\b", "WildbgFast", block)
fast = fast.replace("WildbgApi<MultiPlyEvaluator<CompositeEvaluator>>", "WildbgApi<CompositeEvaluator>")
fast = fast.replace("WildbgApi::with_evaluator(MultiPlyEvaluator { evaluator })", "WildbgApi::with_evaluator(evaluator)")
fast = fast.replace("console_error_panic_hook::set_once();", "")
assert "MultiPly" not in fast, "patch no longer matches wildbg's source"
src = src[:end] + fast + src[end:]
open(p, "w").write(src)
print("added WildbgFast")
