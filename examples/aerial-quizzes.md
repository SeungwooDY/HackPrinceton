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
  These are not screen pixels or Matterport 3D coordinates.
- `quiz.question`: the question text (up to 300 characters).
- `quiz.options`: two to four answer strings (up to 150 characters each).
- `quiz.correctIndex`: the correct option's index, starting at zero.
- Optional `description` and `explanation`: text shown before and after answering.

Imports replace the current property's quiz set and clear previous quiz answers.
Manual hotspots remain separate. Imported points and quiz progress save in this
browser, per model. Export the JSON to share the quiz set with someone else.
The importer rejects mismatched model IDs, duplicate IDs, invalid quizzes, and
positions outside the widest supported image (±800 m east and ±533.33 m north).
Zoom out to see points outside the current view.

The example contains training checkpoints, not verified outdoor feature locations.
