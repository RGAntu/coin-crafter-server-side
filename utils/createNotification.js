const createNotification = async (db, { message, toEmail, actionRoute }) => {
  const notificationsCollection = db.collection("notifications");
  await notificationsCollection.insertOne({
    message,
    toEmail,
    actionRoute,
    time: new Date()
  });
};
module.exports = { createNotification };