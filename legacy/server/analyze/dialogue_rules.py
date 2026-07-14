"""Dialogue extraction rules — shared by Gemini and freemium extract prompts."""

DIALOGUE_EXTRACTION = """
DIALOGUE EXTRACTION PIPELINE (apply in order for every paragraph):

Step 1 — QUOTED SPEECH: Every span inside quotation marks becomes its own line.
  kind=dialogue, character_id=the speaker (slug), text=spoken words ONLY.
  Strip quote marks from text — the marks are not spoken aloud.

Step 2 — SPEECH TAGS: Any attribution outside quotes (said X, asked Y, he replied,
  she whispered, etc.) becomes a separate narrator line IMMEDIATELY after the
  dialogue it attributes (or before, if the book puts the tag first).
  kind=narration, character_id=narrator, line_weight=normal.
  Text must match the book EXACTLY — copy the tag verbatim:
    Source: he said quietly.  → text='he said quietly.'  (keep "he", do NOT write "Kuro")
    Source: said Mei.         → text='said Mei.'
  Never paraphrase, substitute names for pronouns, or invent words not in the source.
  Use kind=delivery ONLY for stylized HOW (sang, yelled, screamed, sobbed,
  laughed, muttered with emphasis) — NOT for plain said/asked/replied.

Step 3 — NARRATOR EXPOSITION: All remaining prose (scene description, action,
  interior summary that is not quoted speech) → kind=narration, character_id=narrator.

Step 4 — THOUGHTS: Internal monologue → kind=thought, character_id=thinker.

INTERRUPTED DIALOGUE (common pattern — follow exactly):
  Source: "Whatever you wish for," he said quietly. "The coin only summoned me."
  Output lines:
    1. character_id=kuro, kind=dialogue, text='Whatever you wish for,'
    2. character_id=narrator, kind=narration, text='he said quietly.'
    3. character_id=kuro, kind=dialogue, text='The coin only summoned me.'

SPEAKER RESOLUTION (character_id only — never rewrite tag text):
  - Explicit tag ('said Mei') → preceding dialogue character_id=mei.
  - Turn-taking when the book gives no tag.
  - Pronoun in tag ('he said') → assign character_id on the DIALOGUE line from
    context; leave the tag text as written ('he said', not the character name).
  - Self-identification in dialogue overrides turn order.

VERBATIM COVERAGE (critical): every word of the source book appears in exactly
one line, unchanged. No summarizing, skipping, merging distinct sentences, or
substituting words. bookNLP-style segmentation with AI scene/character attribution.
"""

DIALOGUE_EXAMPLES = """
Examples:
  Source: "It is cold," sang Mira.
  → dialogue mira: 'It is cold,'
  → delivery narrator (minor): 'sang Mira'  (stylized HOW → delivery OK)

  Source: "Hello," said Orin.
  → dialogue orin: 'Hello,'
  → narration narrator: 'said Orin.'  (verbatim tag from the book)

  Source: The wind picked up. Mei shivered.
  → narration narrator: 'The wind picked up. Mei shivered.'
"""
