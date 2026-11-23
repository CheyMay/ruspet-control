export const notificationTopics={
 assignments:'Новые задачи',
 deadlines:'Крайние сроки и просрочки',
 approvals:'Согласования и приёмка',
 reminders:'Личный план и напоминания',
 updates:'Отчёты и другие события'
} as const;
export type NotificationTopic=keyof typeof notificationTopics;
export type NotificationTopics=Partial<Record<NotificationTopic,boolean>>;
export type NotificationPreferences={
 telegramDigest:boolean;pushEnabled:boolean;telegramTopics:NotificationTopics;pushTopics:NotificationTopics;
};
