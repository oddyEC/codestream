import { ActionType } from "../common";
import * as actions from "./actions";
import { ConfigsActionsType, ConfigsState } from "./types";
import * as url from "url";

type ConfigsActions = ActionType<typeof actions>;

const initialState: ConfigsState = {
	showHeadshots: true,
	debug: false,
	serverUrl: "",
	isOnPrem: false
};

export function reduceConfigs(state = initialState, { type, payload }: ConfigsActions) {
	switch (type) {
		case ConfigsActionsType.Update:
			return { ...state, ...payload };
		default:
			return { ...initialState, ...state };
	}
}

export const supportsSSOSignIn = (configs: Partial<ConfigsState>) => {
	// we can't support SSO sign-in if we are not using https
	if (!configs.serverUrl || url.parse(configs.serverUrl).protocol === "https:") {
		return true;
	} else {
		return false;
	}
};
