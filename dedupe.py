"""Remove the accidentally duplicated ctx-shape test block in host-kernel tests."""
import pathlib

p = pathlib.Path('tests/host-kernel.test.mjs')
s = p.read_text(encoding='utf-8')

START = "test('ctx: events and bus have the same shape"
HEADER = "// ---------------------------------- lifecycle ----------------------------------"

first = s.index(START)
second = s.index(START, first + 1)
header = s.index(HEADER, second)

# drop everything from the second copy up to (not including) the section header
fixed = s[:second] + s[header:]
p.write_text(fixed, encoding='utf-8')

count = fixed.count(START)
print(f'block now appears {count} time(s); removed {header - second} chars')
assert count == 1, 'expected exactly one copy'
