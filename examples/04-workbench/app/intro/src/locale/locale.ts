import { ILocaleMessages } from "@shrub/vue-i18n";

export interface IIntroLocale extends ILocaleMessages {
    readonly intro: {
        readonly title: string;
    };
}