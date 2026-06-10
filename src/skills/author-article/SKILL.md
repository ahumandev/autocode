---
name: author-article
description: Use `author-article` to get Professional Article/Report Format when reviewing/writing user content as articles/reports.
---

# Professional Article/Report Format

Follow these instructions before reviewing/writing professional articles/reports

## Editorial Rules

- Use full human-readable sentences by default
- Reduce long sentences > 40 words to smaller sentences (except in quoted text)
- Fix spelling and grammar mistakes (except in quoted text)
- Use British English by default in articles (unless different language requested)
- Merge repetitions
- Group long sections of continuous sentences in paragraphs, each paragraph focus on 1 argument/point of message.
- A paragraph typically starts with a statement/fact, then contain sentences that explain this statement with examples.
- Ensure content of the article does not deviate from topic of mentioned in the introduction section
- Capitalize first letter of every word in titles, except short prepositions < 4 characters (in, on, at, to, by, of, up), conjunctions (and, but, for, or, not, so, yet), and articles (a, an, the).
- NEVER modify quoted text even if it contains errors
- NEVER change the meaning of the text, unless the user explicitly asked to do so

## Style Rules

- Add an introduction (if missing): Introductions should make it clear what topic the article will explore without giving away the main argument or point of the article. The introduction should rather trigger the reader's curiosity and encourage them to read it. The introduction should not be offensive to any group or people with a strong view point against the article main argument.
- Write articles in third person
- Check if the author's tone appears arrogant, offensive, or divisive. Replace sarcasm or rhetorical questions with objective statements.
- Write content diplomatically so it does not offend any people group.
- Use a professional tone, but explain academic or technical words in basic layman terms so non-Christians can understand.
- Only allow statements like "I think", "We believe", "It's possible" if the author uses unproven opinions.
- Replace em-dashes (—) and en-dashes (–) by breaking sentences up into multiple short sentences with periods that flow into each other (except in quoted text).
- Replace only Old Testament bible verses that refer to `the Lord` (lowercase) with `the LORD` (ALL CAPS). New Testament bible verses may refer to `the Lord` (lowercase).
- Use basic English vocabulary or explain complex academical terminology so that a non-English speaker or layman can understand.
- The final conclusion should only summarize the main argument, point or purpose of the article without explanations and evidence. Each statement in conclusion should be backed by section in the main content with a Markdown link in the text to that section for further reading or evidence.

## Credibility Rules

- Rephrase confusing explanations, contradictions or fallacies
- Clearly indicate what is facts vs what is opinions
- Check that bible verses are quoted correctly from the bible: If a bible verse is incorrectly quoted, fix the quote. If the correct bible verses was referenced by comparing the context/sentence in which the bible verse appear. For example `Jesus said love your enemies (Genesis 1:1)` is wrong because that is not what Genesis 1:1 says. In these cases, replace it with the correct scripture reference.
- Add additional evidence like bible scriptures or Markdown links in text to external websites to support the author's statements (if known sources are available)
- Remove contradictions against the author's own content
- The article should never contradict itself. Instead it should objectively list the different views of groups and let the reader decide which view he prefers.
- Check for reasoning errors or fallacies: Rephrase the author's arguments to communicate the intended message but without logical reasoning errors.
- When author make controversial statement: add typical critique (argument) and defense (counter-argument).
- Enhance weak arguments with evidence or rephrase if no evidence could be provided.
- If article links to external sites, check that sites exist and if not: Search for the site and fix link or remove it if not found.

## Formatting Rules

- The first line (after frontmatter) is the article's main title and must be H1 header level. There should only be 1 H1 title.
- Keep H2 headers as short as possible, but still unique.
- Ensure logical header hierarchy (no skipped levels).
- Large sections (> 25 lines) should be subdivided into smaller subsections.
- Use numerical points if the article mentions a specific sequence or priority.
- Use bullet points only to list items.
- Convert `--` double hyphens in quoted text to em dashes.
- Quoted sources are formatted as `> Quoted text — Source`. Note that the em dash is wrapped with spaces on both sides. The source could be a bible verse, a name of another author or book, or a link to an external website.
- If quoted source is bible verse, then include bible book abbreviation (for example: `John 3:16 (ESV)`); otherwise omit book abbreviation for inline bible references.
- Correct bible verses of different books are separated by semicolons `;`, for example: `Genesis 1; Exodus 1:1; Leviticus 1`.
- Correct bible verses of the same book but different chapters are separated by a comma and a space `, ` for example `Genesis 1:1, 2:1, 3:1`.
- Correct bible verses of the same book and chapter are separated by a comma only `,` (without spaces) for example `Genesis 1:1-3,5-7,11,13`. If no colon `:` is included, you may assume the number refers to a verse of the previously stated chapter, for example `Genesis 1:1,3` means Genesis 1:1 and Genesis 1:3.

## Markdown Rules

- Convert underscore headers `-------------` to hashed prefix headers `##`
- Content should be Markdown linter compliant
- Code samples must be displayed in md code blocks specifying the correct language attribute
- Add Markdown links in text to online websites or external md files in content if content was based on an external source
- Double spaces before EOL character are allowed as they indicate line breaks in Markdown
- Ensure that Markdown links within the same document to anchors/headers are valid.
- Fragments are preserved, for example `path/page.md#anchor`
- Images are co-located in the same directory as Markdown, unless they link to an external website
- Image naming: `{page}.{descriptor}.{ext}` (avoid duplication if the image has the same name as the page, for example `church.church.jpg`)
- Provide alt text for accessibility
- Use mermaid diagrams to explain complex relationships, integrations or architectures
- Strikethrough text as Markdown strikethrough: ~~strikethrough~~
- Inline math formulas as Markdown inline math: $E = mc^2$
- Block math formulas as Markdown block math: $$ ... $$
- Links to online sources as Markdown links: [source name](url)
- Public logos, icons, illustrations as Markdown images: ![alt text](url)

## Layout Rules

Default md layout (unless different layout was requested):
```
---
description: [Description]
keywords: [Keywords]
---

# [Title]

[Introduction]

## [Content Sections]

### [Optional Sub-Sections]

#### [Optional Sub-Sub-Sections...]

## Conclusion

[Conclusion Content]
```

- Conclusion should not repeat the problem, but summarize the solution to the problem mentioned in introduction
- Conclusion MUST contain Markdown links to anchors within the article where the solution was displayed in more detail (like a TOC in natural language)
- Prefer grouping instructions and examples together so that reader can follow instructions without jumping around in article

## Frontmatter Rules

- By default add frontmatter to each article (unless user indicates otherwise).
- The article description will be used as a meta tag element that describes the page for SEO. Ensure that the description is search engine compliant and not longer than 160 characters. The description should compliment the introduction of the article by providing a brief description of which topic the article will explore without giving away the main argument or point of the article. The like the introduction, description should also be non-offensive to any group or view point. Description should not start with a verb, but rather a short intro explaining the problem the article address in such a way that it does not give away the solution but rather trigger curiosity to read further.
- Update the `keywords` field of the frontmatter with sensible csv keywords related to the main points of this article. Use unique keywords that would make this article stand out among other articles. Avoid using common or generic terms as keywords.
