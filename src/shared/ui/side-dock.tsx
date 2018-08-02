import * as React from "react";
import { observable, action } from "mobx";
import { observer } from "mobx-react";
import * as classNames from "classnames";
import { bind } from "bind-decorator";

import { Splitter } from "shared/ui/splitter";
import { VerticalHeaderWithBody, Header, Body } from "shared/ui/header-with-body";

@observer
export class SideDock extends React.Component<{
    persistId: string;
    layoutId: string;
    defaultLayoutConfig: any;
    registerComponents: (goldenLayout: any) => void;
    header?: JSX.Element;
}> {
    static DEFAULT_SETTINGS = {
        showPopoutIcon: false,
        showMaximiseIcon: false,
        showCloseIcon: false
    };
    static DEFAULT_DIMENSIONS = {
        borderWidth: 8,
        headerHeight: 26
    };

    @observable isOpen: boolean;

    constructor(props: any) {
        super(props);

        this.isOpen =
            localStorage.getItem(this.props.persistId + "/is-open") === "0" ? false : true;
    }

    @action.bound
    toggleIsOpen() {
        this.isOpen = !this.isOpen;
        localStorage.setItem(this.props.persistId + "/is-open", this.isOpen ? "1" : "0");
    }

    containerDiv: HTMLDivElement | null;

    goldenLayout: any;

    lastWidth: number | undefined;
    lastHeight: number | undefined;

    lastLayoutId: string;

    get layoutLocalStorageItemId() {
        return this.props.persistId + "/" + this.props.layoutId;
    }

    get defaultLayoutConfig() {
        return this.props.defaultLayoutConfig;
    }

    get layoutConfig() {
        const savedStateJSON = localStorage.getItem(this.layoutLocalStorageItemId);
        if (savedStateJSON) {
            try {
                return JSON.parse(savedStateJSON);
            } catch (err) {
                console.error(err);
            }
        }
        return this.defaultLayoutConfig;
    }

    update() {
        this.destroy();

        if (this.goldenLayout) {
            if (!this.containerDiv) {
                this.destroy();
            }
        } else {
            if (this.containerDiv) {
                this.goldenLayout = new GoldenLayout(this.layoutConfig, this.containerDiv);
                this.props.registerComponents(this.goldenLayout);
                this.goldenLayout.on("stateChanged", this.onStateChanged);
                this.goldenLayout.init();

                this.lastLayoutId = this.props.layoutId;
            }
        }
    }

    @bind
    onStateChanged() {
        if (this.goldenLayout) {
            const state = JSON.stringify(this.goldenLayout.toConfig());
            localStorage.setItem(this.layoutLocalStorageItemId, state);
        }
    }

    updateSize() {
        if (this.goldenLayout) {
            const rect = this.containerDiv!.parentElement!.getBoundingClientRect();
            if (this.lastWidth !== rect.width || this.lastHeight !== rect.height) {
                this.goldenLayout.updateSize(rect.width, rect.height);
                this.lastWidth = rect.width;
                this.lastHeight = rect.height;
            }
        }
    }

    destroy() {
        if (this.goldenLayout) {
            this.goldenLayout.destroy();
            this.goldenLayout = undefined;
            this.lastWidth = undefined;
            this.lastHeight = undefined;
        }
    }

    componentDidMount() {
        this.update();
    }

    componentDidUpdate() {
        this.update();
    }

    componentWillUnmount() {
        this.destroy();
    }

    render() {
        const dockSwitcherClassName = classNames("EezStudio_SideDockSwitch", {
            EezStudio_SideDockSwitch_Closed: !this.isOpen
        });

        const dockSwitcher = <div className={dockSwitcherClassName} onClick={this.toggleIsOpen} />;

        let sideDock;

        if (this.isOpen) {
            const container = (
                <div ref={ref => (this.containerDiv = ref)} style={{ overflow: "visible" }} />
            );

            if (this.props.header) {
                sideDock = (
                    <React.Fragment>
                        <VerticalHeaderWithBody className="EezStudio_SideDock_WithHeader">
                            <Header>{this.props.header}</Header>
                            <Body>{container}</Body>
                        </VerticalHeaderWithBody>
                        {dockSwitcher}
                    </React.Fragment>
                );
            } else {
                sideDock = (
                    <React.Fragment>
                        {container}
                        {dockSwitcher}
                    </React.Fragment>
                );
            }
        } else {
            sideDock = dockSwitcher;
        }

        if (this.isOpen) {
            return (
                <Splitter
                    type="horizontal"
                    sizes={"100%|240px"}
                    persistId="shared/ui/chart"
                    childrenOverflow="auto|visible"
                >
                    {this.props.children}
                    {sideDock}
                </Splitter>
            );
        } else {
            return (
                <React.Fragment>
                    {this.props.children}
                    {sideDock}
                </React.Fragment>
            );
        }
    }
}
