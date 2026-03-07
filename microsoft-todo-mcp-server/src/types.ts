export interface MicrosoftTodoConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tenantId: string;
}

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export interface TodoTaskList {
  id: string;
  displayName: string;
  isOwner: boolean;
  isShared: boolean;
  wellknownListName: string;
}

export interface TodoTask {
  id: string;
  title: string;
  body?: { content: string; contentType: string };
  importance: "low" | "normal" | "high";
  status: "notStarted" | "inProgress" | "completed" | "waitingOnOthers" | "deferred";
  isReminderOn: boolean;
  reminderDateTime?: { dateTime: string; timeZone: string };
  dueDateTime?: { dateTime: string; timeZone: string };
  completedDateTime?: { dateTime: string; timeZone: string };
  createdDateTime: string;
  lastModifiedDateTime: string;
  categories: string[];
  linkedResources?: LinkedResource[];
  recurrence?: PatternedRecurrence;
}

export interface LinkedResource {
  id: string;
  webUrl: string;
  applicationName: string;
  displayName: string;
}

export interface PatternedRecurrence {
  pattern: {
    type: "daily" | "weekly" | "absoluteMonthly" | "relativeMonthly" | "absoluteYearly" | "relativeYearly";
    interval: number;
    daysOfWeek?: string[];
    dayOfMonth?: number;
    month?: number;
    firstDayOfWeek?: string;
  };
  range: {
    type: "endDate" | "noEnd" | "numbered";
    startDate: string;
    endDate?: string;
    numberOfOccurrences?: number;
  };
}

export interface ChecklistItem {
  id: string;
  displayName: string;
  isChecked: boolean;
  createdDateTime: string;
}
