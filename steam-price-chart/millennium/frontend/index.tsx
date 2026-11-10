import { definePlugin, Field } from 'millennium';

const Icon = () => (
	<svg width="16" height="16" viewBox="0 0 16 16" style={{ marginRight: '5px' }} aria-hidden="true">
		<path d="M1 13 L5 8 L8 10 L12 4 L15 6" fill="none" stroke="currentColor" strokeWidth="1.6" />
	</svg>
);

const SettingsContent = () => (
	<>
		<Field
			label="Где смотреть"
			description="Откройте любую игру в магазине Steam: под ценой появится график истории цены и таблица цен по регионам."
			bottomSeparator="standard"
		/>
		<Field
			label="Ключ IsThereAnyDeal"
			description="Для графика нужен бесплатный ключ API IsThereAnyDeal (isthereanydeal.com/apps/my). Вставьте его кнопкой «Настройки» в самом виджете на странице игры. Таблица цен работает и без ключа."
			bottomSeparator="none"
		/>
	</>
);

export default definePlugin(() => {
	return {
		title: 'Steam Price Chart',
		icon: <Icon />,
		content: <SettingsContent />,
	};
});
