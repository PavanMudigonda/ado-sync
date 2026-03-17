# Saffron Component Tests

Prose test specs for Saffron Design System components that have missing or placeholder coverage.
Each `###` heading = one Azure DevOps test case. Steps are listed under **Steps:**. The `@tc:`
tag (written back by `ado-sync push`) links the scenario to an existing Azure test case ID.

---

## sr-only

The `sr-only` component renders a screen-reader-only wrapper. Tag: `<sr-only>`.

### should set ID property correctly

@tc:41082
@smoke

Steps:
1. Render `<sr-only id="test-id"></sr-only>`
2. Check: the element exists in the DOM

---

### should render slotted content inside the element
@tc:42101
@smoke

Steps:
1. Render `<sr-only>Hidden label</sr-only>`
2. Check: the element contains the text "Hidden label"

---

## progress-text

The `ProgressText` component has an `@observable` property `processingContent` that defaults to `"Processing"`.

### should pass placeholder assertion

@tc:40766
@smoke

Steps:
1. Assert that `0` equals `0`

Expected results:
- `0` equals `0`

---

### should render with the default processingContent value
@tc:42102
@smoke

Steps:
1. Render `<saf-progress-text></saf-progress-text>`
2. Read the element's `processingContent` JS property

Expected results:
- The `processingContent` JS property equals `"Processing"`

---

### should reflect a custom processingContent value when the property is set
@tc:42103
@smoke

Steps:
1. Render `<saf-progress-text></saf-progress-text>`
2. Set the element's `processingContent` property to `"Saving…"`
3. Check the rendered text inside the element

Expected results:
- The rendered text inside the element includes `"Saving…"`

---

## file-upload

The `FileUpload` component wraps a hidden `<input type="file">`. It emits `files-selected` on
success and `invalid-selection` (with a `reason` of `"type"`, `"size"`, or `"too-many"`) on rejection.

### should pass placeholder assertion

@tc:40424
@smoke

Steps:
1. Assert that `0` equals `0`

Expected results:
- `0` equals `0`

---

### should reflect the accept attribute on the component
@tc:42104
@smoke

Steps:
1. Render `<saf-file-upload accept=".pdf,.docx"></saf-file-upload>`
2. Check the `accept` attribute on the element

Expected results:
- The element has `accept=".pdf,.docx"`

---

### should set the multiple attribute when provided
@tc:42105
@smoke

Steps:
1. Render `<saf-file-upload multiple></saf-file-upload>`
2. Check for the `multiple` attribute on the element

Expected results:
- The element has the boolean attribute `multiple`

---

### should not have the multiple attribute by default
@tc:42106
@smoke

Steps:
1. Render `<saf-file-upload></saf-file-upload>`
2. Check for the `multiple` attribute on the element

Expected results:
- The element does not have the `multiple` attribute

---

### should emit files-selected with accepted files when a valid file is picked
@tc:42107
@smoke

Steps:
1. Render `<saf-file-upload></saf-file-upload>`
2. Listen for the `files-selected` custom event on the element
3. Programmatically dispatch a `change` event on the hidden input containing one valid file
4. Check whether `files-selected` was emitted

Expected results:
- `files-selected` was emitted exactly once
- The event detail contains a `files` array with one entry

---

### should emit invalid-selection with reason type when the file type does not match accept
@tc:42108
@smoke

Steps:
1. Render `<saf-file-upload accept=".pdf"></saf-file-upload>`
2. Listen for the `invalid-selection` custom event on the element
3. Programmatically dispatch a `change` event on the hidden input with a `.txt` file
4. Check the emitted event detail

Expected results:
- `invalid-selection` was emitted with `reason === "type"`
- The `rejected` array in the event detail contains the rejected file

---

### should emit invalid-selection with reason size when a file exceeds max-file-size
@tc:42109
@smoke

Steps:
1. Render `<saf-file-upload max-file-size="1024"></saf-file-upload>`
2. Listen for the `invalid-selection` custom event on the element
3. Programmatically dispatch a `change` event with a file whose `size` is 2048 bytes
4. Check the emitted event detail

Expected results:
- `invalid-selection` was emitted with `reason === "size"`

---

### should emit invalid-selection with reason too-many when file count exceeds max-files
@tc:42110
@smoke

Steps:
1. Render `<saf-file-upload multiple max-files="2"></saf-file-upload>`
2. Listen for the `invalid-selection` custom event on the element
3. Programmatically dispatch a `change` event with 3 files
4. Check both emitted events

Expected results:
- `invalid-selection` was emitted with `reason === "too-many"`
- `files-selected` was also emitted with 2 accepted files

---

### should reject all files when current-files-count already equals max-files
@tc:42111
@smoke

Steps:
1. Render `<saf-file-upload multiple max-files="2" current-files-count="2"></saf-file-upload>`
2. Listen for both `invalid-selection` and `files-selected` events on the element
3. Programmatically dispatch a `change` event with 1 file
4. Check which events were emitted

Expected results:
- `invalid-selection` was emitted with `reason === "too-many"`
- `files-selected` was not emitted

---

## file-upload-dropzone

`FileUploadDropzone` extends `FileUpload` with drag-and-drop. It toggles a `"dragover"` CSS class
on its internal `.dropzone` div and delegates accepted files to the nested `saf-file-upload`.

### should add the dragover class when a drag enters the dropzone
@tc:42112
@smoke

Steps:
1. Navigate to the `preview-file-upload-dropzone--overview` Storybook story
2. Render `<saf-file-upload-dropzone></saf-file-upload-dropzone>`
3. Dispatch a `dragover` event on the element
4. Check the CSS class on the internal `.dropzone` div

Expected results:
- The `.dropzone` div has the CSS class `dragover`

---

### should remove the dragover class when a drag leaves the dropzone
@tc:42113
@smoke

Steps:
1. Render `<saf-file-upload-dropzone></saf-file-upload-dropzone>`
2. Dispatch a `dragover` event to add the `dragover` class
3. Dispatch a `dragleave` event on the element
4. Check the CSS class on the internal `.dropzone` div

Expected results:
- The `.dropzone` div does not have the CSS class `dragover`

---

### should remove the dragover class on drop
@tc:42114
@smoke

Steps:
1. Render `<saf-file-upload-dropzone></saf-file-upload-dropzone>`
2. Dispatch a `dragover` event to add the `dragover` class
3. Dispatch a `drop` event with an empty `dataTransfer.files` on the element
4. Check the CSS class on the internal `.dropzone` div

Expected results:
- The `.dropzone` div does not have the CSS class `dragover`

---

### should emit files-selected when valid files are dropped onto the dropzone
@tc:42115
@smoke

Steps:
1. Render `<saf-file-upload-dropzone><saf-file-upload></saf-file-upload></saf-file-upload-dropzone>`
2. Listen for the `files-selected` custom event on the element
3. Dispatch a `drop` event with a `dataTransfer` containing one valid file
4. Check whether `files-selected` was emitted

Expected results:
- `files-selected` was emitted exactly once

---

### should prevent default browser behaviour on dragover and drop events
@tc:42116
@smoke

Steps:
1. Render `<saf-file-upload-dropzone></saf-file-upload-dropzone>`
2. Dispatch a `dragover` event and capture whether `preventDefault` was called
3. Dispatch a `drop` event and capture whether `preventDefault` was called

Expected results:
- `preventDefault` was called on the `dragover` event
- `preventDefault` was called on the `drop` event

---

## activity

`Activity` renders a time-stamped activity list. Attributes: `time`, `header-id` (default `"headerId"`),
`time-id` (default `"timeId"`).

### should have role of list

@tc:41424
@smoke

Steps:
1. Navigate to the `components-activity--overview` Storybook story
2. Render `<saf-activity></saf-activity>`
3. Check the accessible role of the component

Expected results:
- The element contains an element with `role="list"`

---

### should render the time element when the time attribute is present
@tc:42117
@smoke

Steps:
1. Render `<saf-activity time="4 hours ago"></saf-activity>`
2. Check the `time` attribute value and the number of `.time` elements

Expected results:
- The element has `time="4 hours ago"`
- There is exactly one `.time` element inside the component

---

### should set aria-labelledby to the provided value

@tc:39792
@smoke

Steps:
1. Render `<saf-activity aria-labelledby="headerId timeId"></saf-activity>`
2. Check the `aria-labelledby` attribute on the element

Expected results:
- The element has `aria-labelledby="headerId timeId"`

---

### should set the header-id attribute to the provided value
@tc:42118
@smoke

Steps:
1. Render `<saf-activity header-id="my-header"></saf-activity>`
2. Check the `header-id` attribute on the element

Expected results:
- The element has `header-id="my-header"`

---

### should default header-id to headerId when not provided
@tc:42119
@smoke

Steps:
1. Render `<saf-activity></saf-activity>`
2. Read the element's `headerId` JS property

Expected results:
- The `headerId` JS property equals `"headerId"`

---

### should set the time-id attribute to the provided value
@tc:42120
@smoke

Steps:
1. Render `<saf-activity time-id="my-time"></saf-activity>`
2. Check the `time-id` attribute on the element

Expected results:
- The element has `time-id="my-time"`

---

### should default time-id to timeId when not provided
@tc:42121
@smoke

Steps:
1. Render `<saf-activity></saf-activity>`
2. Read the element's `timeId` JS property

Expected results:
- The `timeId` JS property equals `"timeId"`

---

## activity-note

`ActivityNote` is a child element of `Activity`. It renders a single note item with `role="listitem"`.

### should have role of listitem

@tc:39791
@smoke

Steps:
1. Navigate to the `components-activity-activity-note--activity-note` Storybook story
2. Render `<saf-activity-note></saf-activity-note>`
3. Check the accessible role of the component

Expected results:
- The element contains an element with `role="listitem"`

---

### should render slotted note content
@tc:42122
@smoke

Steps:
1. Render `<saf-activity-note>Note text here</saf-activity-note>`
2. Check the text content of the element

Expected results:
- The element contains the text `"Note text here"`

---

## product-header

`ProductHeader` is the top navigation bar. Attributes: `global-aria-label` (default `"Global"`),
`tasks-aria-label` (default `"Product"`), `is-menu-open`.

### should set global-aria-label to the provided value
@tc:42123
@smoke

Steps:
1. Navigate to the `components-product-header--overview` Storybook story
2. Render `<saf-product-header global-aria-label="My Global Nav"></saf-product-header>`
3. Check the `global-aria-label` attribute on the element

Expected results:
- The element has `global-aria-label="My Global Nav"`

---

### should default global-aria-label to Global when not provided
@tc:42124
@smoke

Steps:
1. Render `<saf-product-header></saf-product-header>`
2. Read the element's `globalAriaLabel` JS property

Expected results:
- The `globalAriaLabel` JS property equals `"Global"`

---

### should set tasks-aria-label to the provided value
@tc:42125
@smoke

Steps:
1. Render `<saf-product-header tasks-aria-label="App Navigation"></saf-product-header>`
2. Check the `tasks-aria-label` attribute on the element

Expected results:
- The element has `tasks-aria-label="App Navigation"`

---

### should default tasks-aria-label to Product when not provided
@tc:42126
@smoke

Steps:
1. Render `<saf-product-header></saf-product-header>`
2. Read the element's `tasksAriaLabel` JS property

Expected results:
- The `tasksAriaLabel` JS property equals `"Product"`

---

### should reflect is-menu-open when set to true
@tc:42127
@smoke

Steps:
1. Render `<saf-product-header is-menu-open="true"></saf-product-header>`
2. Check the `is-menu-open` attribute on the element

Expected results:
- The element has `is-menu-open="true"`

---

### should toggle is-menu-open when the menu button is clicked
@tc:42128
@smoke

Steps:
1. Render `<saf-product-header></saf-product-header>` with a `slot="menu"` containing items
2. Click the menu button inside the component
3. Check `is-menu-open` value
4. Click the menu button again
5. Check `is-menu-open` value

Expected results:
- After the first click `is-menu-open` is truthy
- After the second click `is-menu-open` is falsy

---

## product-header-item

`ProductHeaderItem` is a list item in the product header. Default `role="listitem"`.

### should include a role of listitem by default

@tc:40726
@smoke

Steps:
1. Navigate to the `components-product-header-product-header-item--overview` Storybook story
2. Render `<saf-product-header-item>Item</saf-product-header-item>`
3. Check the `role` attribute on the element

Expected results:
- The element has `role="listitem"`

---

### should render slotted content
@tc:42129
@smoke

Steps:
1. Render `<saf-product-header-item>My Item</saf-product-header-item>`
2. Check the text content of the element

Expected results:
- The element contains the text `"My Item"`

---
