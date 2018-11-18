import { observable } from "mobx";

import {
    ClassInfo,
    registerClass,
    EezObject,
    EezArrayObject,
    PropertyType
} from "project-editor/core/metaData";
import { ProjectStore, asArray, getProperty } from "project-editor/core/store";
import { registerFeatureImplementation } from "project-editor/core/extensions";
import * as output from "project-editor/core/output";

import { Storyboard } from "project-editor/project/features/gui/storyboard";
import { Page } from "project-editor/project/features/gui/page";
import { Style, getDefaultStyle } from "project-editor/project/features/gui/style";
import { Font } from "project-editor/project/features/gui/fontMetaData";
import { Bitmap } from "project-editor/project/features/gui/bitmap";
import { build } from "project-editor/project/features/gui/build";
import { metrics } from "project-editor/project/features/gui/metrics";
import { GuiNavigation } from "project-editor/project/features/gui/GuiNavigation";

////////////////////////////////////////////////////////////////////////////////

export class Gui extends EezObject {
    @observable
    storyboard: Storyboard;

    @observable
    pages: EezArrayObject<Page>;

    @observable
    styles: EezArrayObject<Style>;

    @observable
    fonts: EezArrayObject<Font>;

    @observable
    bitmaps: EezArrayObject<Bitmap>;

    static classInfo: ClassInfo = {
        label: () => "GUI",
        properties: () => [
            {
                name: "storyboard",
                type: PropertyType.Object,
                typeClass: Storyboard,
                hideInPropertyGrid: true
            },
            {
                name: "pages",
                displayName: "Pages (Layouts)",
                type: PropertyType.Array,
                typeClass: Page,
                hideInPropertyGrid: true
            },
            {
                name: "styles",
                type: PropertyType.Array,
                typeClass: Style,
                hideInPropertyGrid: true
            },
            {
                name: "fonts",
                type: PropertyType.Array,
                typeClass: Font,
                hideInPropertyGrid: true,
                check: (object: EezObject) => {
                    let messages: output.Message[] = [];

                    if (asArray(object).length >= 255) {
                        messages.push(
                            new output.Message(
                                output.Type.ERROR,
                                "Max. 254 fonts are supported",
                                object
                            )
                        );
                    }

                    return messages;
                }
            },
            {
                name: "bitmaps",
                type: PropertyType.Array,
                typeClass: Bitmap,
                hideInPropertyGrid: true,
                check: (object: EezObject) => {
                    let messages: output.Message[] = [];

                    if (asArray(object).length >= 255) {
                        messages.push(
                            new output.Message(
                                output.Type.ERROR,
                                "Max. 254 bitmaps are supported",
                                object
                            )
                        );
                    }

                    if (!findStyle("default")) {
                        messages.push(
                            new output.Message(
                                output.Type.ERROR,
                                "'Default' style is missing.",
                                object
                            )
                        );
                    }

                    return messages;
                }
            }
        ],
        navigationComponent: GuiNavigation,
        navigationComponentId: "gui",
        defaultNavigationKey: "storyboard",
        icon: "filter"
    };
}

registerClass(Gui);

////////////////////////////////////////////////////////////////////////////////

registerFeatureImplementation("gui", {
    projectFeature: {
        mandatory: false,
        key: "gui",
        type: PropertyType.Object,
        typeClass: Gui,
        create: () => {
            return {
                pages: [],
                styles: [],
                fonts: [],
                bitmaps: []
            };
        },
        build: build,
        metrics: metrics
    }
});

////////////////////////////////////////////////////////////////////////////////

export function getGui() {
    return ProjectStore.project && (getProperty(ProjectStore.project, "gui") as Gui);
}

export function getPages() {
    let gui = getGui();
    return (gui && gui.pages) || [];
}

export function findPage(pageName: string) {
    let pages = getPages();
    for (const page of pages._array) {
        if (page.name == pageName) {
            return page;
        }
    }
    return undefined;
}

export function findStyle(styleName: any) {
    let gui = getGui();
    let styles = (gui && gui.styles._array) || [];
    for (const style of styles) {
        if (style.name == styleName) {
            return style;
        }
    }
    return undefined;
}

export function findStyleOrGetDefault(styleName: any) {
    return findStyle(styleName) || getDefaultStyle();
}

export function findFont(fontName: any) {
    let gui = getGui();
    let fonts = (gui && gui.fonts) || [];
    for (const font of fonts._array) {
        if (font.name == fontName) {
            return font;
        }
    }
    return undefined;
}

export function findBitmap(bitmapName: any) {
    let gui = getGui();
    let bitmaps = (gui && gui.bitmaps) || [];
    for (const bitmap of bitmaps._array) {
        if (bitmap.name == bitmapName) {
            return bitmap;
        }
    }
    return undefined;
}
