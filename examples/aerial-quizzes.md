# Import aerial quiz points

In the Vexcel view, choose **Export quiz JSON** to download a template for the
current model. Edit it, then choose **Import quiz JSON** to load the file.
`aerial-quizzes.json` is a complete example for the default model. For another
model, change `modelId` to its Matterport model ID, or export from that model.

The file has `version: 1`, `modelId`, and a `points` array. Each point needs:

- `id`: a unique identifier using letters, numbers, hyphens, or underscores.
- `label`: the name shown beneath its marker.
- `east`, `north`: meter offsets from the property's address coordinates.
  Positive east moves right; positive north moves up. Zero/zero is the center.
  These are not screen pixels or Matterport 3D coordinates. For an unlocated task,
  use `null` for both and set `placementStatus` to `unlocated`; it appears in the
  property checklist without a pin. Located tasks can use `candidate` or `reviewed`. Use
  `placementNote` to describe the spatial evidence.
- `quiz.question`: the question text (up to 300 characters).
- `quiz.options`: two to four answer strings (up to 150 characters each).
- `quiz.correctIndex`: the correct option's index, starting at zero.
- Optional `description` and `explanation`: text shown before and after answering.
- Optional `placementNote`: text explaining how a marker position was assigned.
- Optional `evidence`: source entries with `dataset`, `recordId`, `path`, and a
  scalar `value`; optional `origin` and integer `featureId` retain provenance.
  These entries survive import/export and appear under **CoStar evidence**.

Imports replace the current property's quiz set and clear previous quiz answers.
Manual hotspots remain separate. Imported points and quiz progress save in this
browser, per model. Export the JSON to share the quiz set with someone else.
The importer rejects mismatched model IDs, duplicate IDs, invalid quizzes, and
positions outside the widest supported image (±800 m east and ±533.33 m north).
Zoom out to see points outside the current view.

The example contains unlocated training questions in the property checklist, not map pins.

To generate a sourced residential quiz set automatically, run:

```bash
python3 generate_exterior_tasks.py --model-id Ki9YdfpNKum
```

Import the generated `out/exterior_tasks_<listingId>_<modelId>.json` in the
matching model. Tasks remain unlocated unless you supply reviewed anchors or use
`--locate-vexcel` to find candidate features. The UI also provides **Place on image**
and **Move marker** controls. See the main README for generator options and limits.
