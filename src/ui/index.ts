/**
 * React rendering of the shared Draft & Publish card. The view model itself
 * lives in the core package (`deriveDraftPanel`), so a host without React
 * says exactly the same thing.
 */
export {
	deriveDraftPanel,
	type DraftPanelAction,
	type DraftPanelCapabilities,
	type DraftPanelConflict,
	type DraftPanelFieldRow,
	type DraftPanelInput,
	type DraftPanelModel,
	type DraftPanelRecord,
	type DraftPanelRecordInput,
	type DraftPanelTone,
} from "../draftPanel.ts";
export {
	DraftPublishPanel,
	type DraftPanelSessionRecovery,
	type DraftPublishPanelApi,
	type DraftPublishPanelProps,
} from "./DraftPublishPanel.tsx";
