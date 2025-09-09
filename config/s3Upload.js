const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

// Uploads the file and returns the S3 object key (not public URL)
const uploadToS3 = async (fileBuffer, fileName, mimeType) => {
  const key = `${uuidv4()}-${fileName}`;

  const uploadParams = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: mimeType,
  };

  await s3.upload(uploadParams).promise();
  return key; // Return object key instead of public URL
};

module.exports = uploadToS3;
