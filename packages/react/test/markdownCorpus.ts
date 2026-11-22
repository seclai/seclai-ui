// Sample replies for the streaming tests: the constructs whose extent a block
// split could get wrong.

export const samples: Record<string, string> = {
  lists: `Here are your thumbnails:

1. Bold title on red
2. Close-up with arrows

3. A third, after a blank line

Notes:
- One
- Two

  Still in two, as a second paragraph.

- Three

* A new list, as the marker changed
1) And a numbered one with parentheses
2) Second

Done.`,

  nested: `1. Thumbnails
   - Red
     1. Bold title
     2. Small title
        More detail
   - Blue

   Back in the first item.
2. Video
   3. Intro
- Notes
\t- Tab nested`,

  code: `Run this:

\`\`\`py
def f(**kwargs):
    - not a list

    # still code after a blank line
\`\`\`

Then \`inline **code**\` and:

~~~~
\`\`\`
nested fence
\`\`\`
~~~~

    indented code

    more indented code after a blank line

1. Step one:

   \`\`\`sh
   npm install

   npm test
   \`\`\`

2. Step two`,

  tables: `| Name | Value |
| --- | ---: |
| a | 1 |
| b | 2<br>3 |
not a new paragraph, a row

| Only | Header |

| x | y |
|---|---|
| 1 | 2 |

After the table.`,

  quotes: `> A quote
> over lines
lazy continuation

> A second quote

> - list in a quote
>
>   continued

Outside.`,

  headings: `# Title

Intro text
---

Setext heading above, then a rule:

---

## Section *two*

Text with **bold**, _em_, ~~strike~~, a [link](https://example.com) and https://bare.example.com.

- [ ] todo
- [x] done`,

  html: `<details>
<summary>More</summary>

Hidden **markdown** here.

</details>

Text with <sub>sub</sub> and <kbd>Ctrl</kbd>.

<div>

A paragraph in a div

</div>

<!-- a comment

spanning a blank line -->

<b>bold opened

and closed later</b>

<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>

The end.`,

  math: `Inline $x^2$ and $$y$$.

$$
a + b

= c
$$

\\[
\\frac{1}{2}
\\]

Text \\(z\\) after.

\`\`\`math
e = mc^2
\`\`\``,

  mermaid: `A diagram:

\`\`\`mermaid
graph TD

  A --> B
\`\`\`

After.`,

  definitions: `See [the docs][docs] and a note[^1].

More text.

[docs]: https://example.com/docs
[^1]: The note.`,
};
